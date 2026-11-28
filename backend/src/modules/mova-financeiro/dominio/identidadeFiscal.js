// MOVA — IDENTIDADE FISCAL aprendida das notas que o Financeiro já guarda (28/11/2026). Módulo PURO: nenhuma E/S.
//
// A razão social/nome fantasia de um MEI quase nunca é o nome operacional do entregador; o que identifica o prestador é o CPF/CNPJ.
// Este módulo transforma as notas históricas (já ligadas a uma obrigação) em uma identidade por entregador, SEM cadastro manual:
//   - uma nota só vira EVIDÊNCIA FORTE quando é vigente, aprovada por conferência humana (ou confere valor + tomador + período),
//     o valor é o da obrigação e o tomador não é de outra empresa;
//   - um único documento de prestador entre as evidências fortes ⇒ CONSOLIDADA; dois ou mais ⇒ EM_REVISAO (só aquele entregador);
//   - o mesmo documento reivindicado por entregadores diferentes ⇒ EM_REVISAO para todos eles (nada contamina);
//   - notas fracas (rejeitadas, substituídas, de outra empresa, valor diferente) nunca entram na identidade; viram divergência registrada.
// Cada nota pertence à empresa tomadora da SUA obrigação: a identidade pode valer em várias unidades, o documento fiscal não.

export const SITUACAO_IDENTIDADE = Object.freeze({ CONSOLIDADA: "CONSOLIDADA", EM_REVISAO: "EM_REVISAO", SEM_HISTORICO: "SEM_HISTORICO" });
export const FORCA = Object.freeze({ FORTE: "FORTE", FRACA: "FRACA" });
export const FONTE = Object.freeze({ FINANCEIRO: "FINANCEIRO", XML: "XML", PDF_TEXTO: "PDF_TEXTO", IA: "IA" });

export const soDigitos = (s) => String(s ?? "").replace(/\D/g, "");

/** CPF (11) ou CNPJ (14) com dígitos verificadores corretos. Documento de teste/aleatório não vira identidade. */
export function documentoValido(valor) {
  const d = soDigitos(valor);
  if (/^(\d)\1+$/.test(d)) return false;
  if (d.length === 11) {
    const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }
  if (d.length === 14) {
    const dv = (n) => { const p = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
  }
  return false;
}
export const tipoDoDocumento = (d) => (soDigitos(d).length === 14 ? "CNPJ" : soDigitos(d).length === 11 ? "CPF" : null);
/** Para relatórios e telas: nunca o documento inteiro (LGPD). */
export const mascararDocumento = (d) => { const x = soDigitos(d); return x.length === 14 ? `**.***.${x.slice(5, 8)}/****-${x.slice(12)}` : x.length === 11 ? `***.${x.slice(3, 6)}.***-${x.slice(9)}` : "—"; };

const textoOuNulo = (t) => { const s = String(t ?? "").trim(); return s || null; };
const mesDe = (iso) => (/^\d{4}-\d{2}/.test(iso ?? "") ? String(iso).slice(0, 7) : null);

/**
 * Leitura em um formato único, venha ela do Financeiro (prestador/tomador aninhados), do leitor determinístico (XML/PDF) ou da IA
 * (favorecido/documentoDestinatario). O documento do prestador só existe quando a fonte o trouxe (a IA do MOVA não o devolve).
 */
export function normalizarLeitura(l, fonte = FONTE.FINANCEIRO) {
  if (!l || typeof l !== "object") return null;
  const prestadorDoc = soDigitos(l.prestador?.documento ?? l.prestadorDocumento ?? l.documentoRemetente);
  const tomadorDoc = soDigitos(l.tomador?.documento ?? l.tomadorDocumento ?? l.documentoDestinatario);
  const valor = l.valorCentavos ?? null;
  return Object.freeze({
    fonte,
    prestadorDocumento: documentoValido(prestadorDoc) ? prestadorDoc : null,
    prestadorNome: textoOuNulo(l.prestador?.nome ?? l.prestadorNome ?? l.favorecido),
    nomeFantasia: textoOuNulo(l.prestador?.nomeFantasia ?? l.nomeFantasia),
    municipio: textoOuNulo(l.prestador?.municipio ?? l.municipio),
    tomadorDocumento: documentoValido(tomadorDoc) ? tomadorDoc : null,
    tomadorNaoIdentificado: Boolean(l.tomador?.naoIdentificado),
    numero: textoOuNulo(l.numero ?? l.identificadorDocumento),
    chaveAcesso: /^\d{44,50}$/.test(soDigitos(l.chaveAcesso)) ? soDigitos(l.chaveAcesso) : null,
    codigoVerificacao: textoOuNulo(l.codigoVerificacao),
    emissao: l.emissao ?? l.dataEmissao ?? null,
    competencia: l.competencia ?? null,
    periodo: l.periodo ?? null,
    valorCentavos: Number.isSafeInteger(valor) ? valor : null,
  });
}

/**
 * Avalia UMA nota já ligada a uma obrigação.
 * @param nota { leitura, situacao, vigente, unidadeId, entregador, semanaInicio, valorCentavos? }
 * @param obrigacao { valorCentavos, semanaInicio, semanaFim }
 * @param tomadorDaUnidade documento (14 dígitos) da empresa tomadora desta unidade, quando conhecido (configurado ou aprendido)
 */
export function avaliarNota({ nota, obrigacao, tomadorDaUnidade = null }) {
  const l = normalizarLeitura(nota.leitura, nota.fonte ?? FONTE.FINANCEIRO);
  const motivos = [];
  if (!l) return { forca: FORCA.FRACA, motivos: ["SEM_LEITURA"], leitura: null };
  if (nota.vigente === false) motivos.push("NOTA_NAO_VIGENTE");
  if (["NF_REJEITADA", "REJEITADA", "RECUSADA"].includes(nota.situacao)) motivos.push("NOTA_REJEITADA");
  if (!l.prestadorDocumento) motivos.push("SEM_DOCUMENTO_DO_PRESTADOR");
  const valorOk = l.valorCentavos !== null && l.valorCentavos === obrigacao.valorCentavos;
  if (!valorOk) motivos.push("VALOR_DIFERENTE_DA_OBRIGACAO");
  let tomadorOk = null; // null = nota não identifica o tomador (nem a favor nem contra)
  if (l.tomadorDocumento && tomadorDaUnidade) { tomadorOk = l.tomadorDocumento === soDigitos(tomadorDaUnidade); if (!tomadorOk) motivos.push("TOMADOR_DE_OUTRA_EMPRESA"); }
  const mesSemana = mesDe(obrigacao.semanaInicio), mesFim = mesDe(obrigacao.semanaFim ?? obrigacao.semanaInicio);
  const ref = l.periodo?.inicio ? mesDe(l.periodo.inicio) : l.competencia ? mesDe(l.competencia) : null;
  let periodoOk = null;
  if (l.periodo?.inicio) { periodoOk = l.periodo.inicio === obrigacao.semanaInicio && l.periodo.fim === (obrigacao.semanaFim ?? l.periodo.fim); if (!periodoOk) motivos.push("PERIODO_DIFERENTE_DA_SEMANA"); }
  else if (ref) { periodoOk = [mesSemana, mesFim].includes(ref); if (!periodoOk) motivos.push("COMPETENCIA_FORA_DA_SEMANA"); }
  const humana = ["NF_APROVADA", "LIBERADO_PAGAMENTO", "APROVADA"].includes(nota.situacao);
  const ruins = motivos.filter((m) => m !== "SEM_DOCUMENTO_DO_PRESTADOR");
  // FORTE = tem documento do prestador, nenhum sinal contrário, e (aprovada por pessoa OU valor + período + tomador conferidos).
  const confereSozinha = valorOk && tomadorOk === true && periodoOk !== false;
  const forte = Boolean(l.prestadorDocumento) && ruins.length === 0 && (humana || confereSozinha);
  return { forca: forte ? FORCA.FORTE : FORCA.FRACA, motivos, leitura: l, humana, valorOk, tomadorOk, periodoOk };
}

/**
 * Consolida as identidades a partir de TODAS as notas históricas.
 * @param notas [{ organizacaoId, unidadeId, entregador, semanaInicio, sha256, leitura, situacao, vigente, obrigacao:{valorCentavos,semanaInicio,semanaFim} }]
 * @param tomadores Map<unidadeId, documento>  (empresa tomadora de cada unidade)
 * @returns { identidades: Map<entregador, {...}>, avaliacoes: [...], documentosReivindicados }
 */
export function consolidarIdentidades(notas, tomadores = new Map()) {
  const avaliacoes = notas.map((n) => ({ ...n, avaliacao: avaliarNota({ nota: n, obrigacao: n.obrigacao, tomadorDaUnidade: tomadores.get(n.unidadeId) ?? null }) }));
  const porEntregador = new Map();
  for (const a of avaliacoes) { const l = porEntregador.get(a.entregador) ?? []; l.push(a); porEntregador.set(a.entregador, l); }
  // quem reivindica cada documento (só evidências fortes)
  const donos = new Map();
  for (const a of avaliacoes) {
    if (a.avaliacao.forca !== FORCA.FORTE) continue;
    const d = a.avaliacao.leitura.prestadorDocumento;
    donos.set(d, new Set([...(donos.get(d) ?? []), a.entregador]));
  }
  const identidades = new Map();
  for (const [entregador, lista] of porEntregador) {
    const fortes = lista.filter((a) => a.avaliacao.forca === FORCA.FORTE);
    const documentos = [...new Set(fortes.map((a) => a.avaliacao.leitura.prestadorDocumento))];
    const fracasComOutroDocumento = lista.filter((a) => a.avaliacao.forca === FORCA.FRACA && a.avaliacao.leitura?.prestadorDocumento && !documentos.includes(a.avaliacao.leitura.prestadorDocumento));
    let situacao = SITUACAO_IDENTIDADE.SEM_HISTORICO, motivo = "SEM_NOTA_COM_EVIDENCIA_FORTE", documento = null;
    if (documentos.length === 1) {
      documento = documentos[0];
      const compartilhado = (donos.get(documento)?.size ?? 0) > 1;
      if (compartilhado) { situacao = SITUACAO_IDENTIDADE.EM_REVISAO; motivo = "DOCUMENTO_USADO_POR_OUTRO_ENTREGADOR"; }
      else { situacao = SITUACAO_IDENTIDADE.CONSOLIDADA; motivo = "EVIDENCIA_INEQUIVOCA"; }
    } else if (documentos.length > 1) { situacao = SITUACAO_IDENTIDADE.EM_REVISAO; motivo = "DOCUMENTOS_DIFERENTES_ENTRE_NOTAS_FORTES"; }
    else if (lista.some((a) => a.avaliacao.leitura?.prestadorDocumento)) { motivo = "SO_HA_NOTAS_FRACAS"; }
    identidades.set(entregador, Object.freeze({
      entregador, situacao, motivo, documento: situacao === SITUACAO_IDENTIDADE.CONSOLIDADA ? documento : null, candidatos: documentos,
      nome: fortes.find((a) => a.avaliacao.leitura.prestadorNome)?.avaliacao.leitura.prestadorNome ?? null,
      unidades: [...new Set(fortes.map((a) => a.unidadeId))], notasFortes: fortes.length, notasAnalisadas: lista.length,
      divergencias: fracasComOutroDocumento.map((a) => ({ sha256: a.sha256 ?? null, unidadeId: a.unidadeId, semanaInicio: a.semanaInicio, motivos: a.avaliacao.motivos })),
    }));
  }
  return Object.freeze({ identidades, avaliacoes, documentosReivindicados: donos });
}

/**
 * Aprende a empresa tomadora de cada unidade quando ela não está configurada: o documento do tomador que aparece, sozinho, nas notas
 * APROVADAS da unidade, em pelo menos `minimo` notas de `minimoEntregadores` entregadores. Qualquer conflito ⇒ não aprende (nada é chutado).
 */
export function aprenderTomadores(notas, { minimo = 3, minimoEntregadores = 2 } = {}) {
  const porUnidade = new Map();
  for (const n of notas) {
    if (n.vigente === false || !["NF_APROVADA", "LIBERADO_PAGAMENTO", "APROVADA"].includes(n.situacao)) continue;
    const l = normalizarLeitura(n.leitura);
    if (!l?.tomadorDocumento) continue;
    const u = porUnidade.get(n.unidadeId) ?? new Map();
    const e = u.get(l.tomadorDocumento) ?? { notas: 0, entregadores: new Set() };
    e.notas += 1; e.entregadores.add(n.entregador); u.set(l.tomadorDocumento, e); porUnidade.set(n.unidadeId, u);
  }
  const resultado = new Map();
  for (const [unidadeId, docs] of porUnidade) {
    const todos = [...docs.entries()].sort((a, b) => b[1].notas - a[1].notas);
    const [doc, e] = todos[0] ?? [];
    if (todos.length === 1 && e.notas >= minimo && e.entregadores.size >= minimoEntregadores) resultado.set(unidadeId, { documento: doc, notas: e.notas, entregadores: e.entregadores.size, situacao: "APRENDIDO" });
    else if (todos.length) resultado.set(unidadeId, { documento: null, notas: todos.reduce((t, [, x]) => t + x.notas, 0), entregadores: 0, situacao: todos.length > 1 ? "CONFLITO" : "EVIDENCIA_INSUFICIENTE" });
  }
  return resultado;
}

/**
 * Compara o prestador da nota NOVA com a identidade do entregador. O documento é a evidência principal; razão social/nome fantasia
 * diferentes do nome operacional NUNCA bastam para divergir.
 * @returns { resultado: "CONFERE"|"DIFERENTE"|"SEM_IDENTIDADE"|"DOCUMENTO_NAO_LIDO"|"EM_REVISAO", motivo }
 */
export function compararPrestador(identidade, leituraNormalizada) {
  const doc = leituraNormalizada?.prestadorDocumento ?? null;
  if (!identidade || identidade.situacao === SITUACAO_IDENTIDADE.SEM_HISTORICO) return { resultado: "SEM_IDENTIDADE", motivo: "ENTREGADOR_SEM_HISTORICO_FISCAL" };
  if (identidade.situacao === SITUACAO_IDENTIDADE.EM_REVISAO) return { resultado: "EM_REVISAO", motivo: identidade.motivo ?? "IDENTIDADE_EM_REVISAO" };
  if (!doc) return { resultado: "DOCUMENTO_NAO_LIDO", motivo: "NOTA_SEM_CPF_CNPJ_LEGIVEL" };
  return doc === identidade.documento ? { resultado: "CONFERE", motivo: "MESMO_CPF_CNPJ_DO_HISTORICO" } : { resultado: "DIFERENTE", motivo: "CPF_CNPJ_DIFERENTE_DO_HISTORICO" };
}

/**
 * Entregador SEM histórico: a primeira nota é candidata. Consolida sozinha quando vem do telefone cadastrado (garantido por quem chama),
 * ligada à obrigação, com valor, período e tomador conferidos, com CPF/CNPJ válido e sem o documento ser de outro entregador.
 * Sem correspondência inequívoca ⇒ pendente de validação administrativa só desse caso.
 */
export function avaliarPrimeiraNota({ leitura, obrigacao, tomadorDaUnidade, documentoJaUsadoPorOutro = false }) {
  const av = avaliarNota({ nota: { leitura, situacao: "RECEBIDA", vigente: true }, obrigacao, tomadorDaUnidade });
  const l = av.leitura;
  if (!l?.prestadorDocumento) return { consolidar: false, motivo: "NOTA_SEM_CPF_CNPJ_LEGIVEL", avaliacao: av };
  if (documentoJaUsadoPorOutro) return { consolidar: false, motivo: "DOCUMENTO_USADO_POR_OUTRO_ENTREGADOR", avaliacao: av };
  const contra = av.motivos.filter((m) => m !== "SEM_DOCUMENTO_DO_PRESTADOR");
  if (contra.length) return { consolidar: false, motivo: contra[0], avaliacao: av };
  if (!(av.valorOk && av.tomadorOk === true && av.periodoOk !== false)) return { consolidar: false, motivo: av.tomadorOk === null ? "TOMADOR_NAO_CONFIRMADO" : "EVIDENCIA_INSUFICIENTE", avaliacao: av };
  return { consolidar: true, motivo: "EVIDENCIA_INEQUIVOCA_DA_PRIMEIRA_NOTA", avaliacao: av };
}

/** Texto do aviso à administração para o caso excepcional (sem CPF/CNPJ completo). */
export const resumoDeRevisao = (id) => ({ entregador: id.entregador, situacao: id.situacao, motivo: id.motivo, documentos: (id.candidatos ?? []).map(mascararDocumento) });
