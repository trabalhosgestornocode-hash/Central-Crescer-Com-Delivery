// IDENTIFICAÇÃO DA UNIDADE — determinística e fail-closed. A unidade NUNCA vem do provedor nem da IA sozinha.
//
// Evidências, em ordem de força:
//   1. o grupo só atende UMA unidade (configuração)                      → essa unidade;
//   2. menção explícita no texto/legenda a um apelido configurado        → essa unidade (só entre as do grupo);
//   3. identificador do destinatário no documento (ex.: CNPJ, extraído) → a unidade dona desse identificador;
//   3b. (24/11) PAGADOR do comprovante (titular/documento da conta de origem, cadastro `pagadores`) → a unidade dona dele;
//   4. sugestão da IA (apelido)                                          → só CONFIRMA; sozinha não decide.
// O pagador identifica a unidade mesmo num grupo/conversa com várias unidades (o usuário não precisa escrevê-la); nunca dá
// acesso: pagador de unidade FORA da conversa ⇒ DOCUMENTO_DE_OUTRA_UNIDADE (nada é gravado; orientação para o canal certo).
// Conflito entre evidências (texto diz uma, documento diz outra) ⇒ DOCUMENTO_DE_OUTRA_UNIDADE / UNIDADE_CONFLITANTE: bloqueia.
// Nenhuma evidência ⇒ UNIDADE_NAO_IDENTIFICADA: bloqueia e pede esclarecimento. Documento de unidade FORA do grupo ⇒ bloqueia.
import { normalizar, normalizarDocumento } from "./configuracao.js";
import { RESULTADO_PAGADOR, unidadePeloPagador } from "./pagador.js";

export const RESULTADO_UNIDADE = Object.freeze({
  IDENTIFICADA: "IDENTIFICADA",
  NAO_IDENTIFICADA: "UNIDADE_NAO_IDENTIFICADA",
  CONFLITANTE: "UNIDADE_CONFLITANTE",
  DOCUMENTO_DE_OUTRA_UNIDADE: "DOCUMENTO_DE_OUTRA_UNIDADE",
  FORA_DO_GRUPO: "UNIDADE_FORA_DO_GRUPO",
  // 27/11: o texto (ou a leitura do documento) cita EXPRESSAMENTE uma loja da mesma empresa que existe no cadastro da plataforma
  // mas NÃO está habilitada no MOVA (ex.: "Subway North Shopping"). Bloqueia: nada é criado em nenhuma outra unidade.
  NAO_HABILITADA: "UNIDADE_NAO_HABILITADA",
});

/** Unidades citadas no texto (apelido inteiro, por palavra). */
export function unidadesCitadas(texto, unidades) {
  const t = ` ${normalizar(texto)} `;
  if (t.trim() === "") return [];
  return unidades.filter((u) => u.apelidos.some((a) => t.includes(` ${a} `)));
}

// 27/11 — MARCA × LOJA. Achado em produção: "Controle de pragas subway North Shopping" virou Subway Saci, porque o apelido
// "subway" (a MARCA, comum a toda a rede) bastava para identificar a loja. Agora:
//   - apelido que é só o COMEÇO do nome da própria loja ("subway" de "subway saci"; "acai" e "acai no grau" de "acai no grau
//     saci") é MARCA: nunca identifica a loja sozinho (só confirma outra evidência, ou responde a "de qual unidade?");
//   - o nome completo e os demais apelidos ("subway saci", "acai saci") são ESPECÍFICOS: identificam a loja;
//   - lojas da MESMA empresa que estão no cadastro da plataforma e não no MOVA (`cfg.unidadesNaoHabilitadas`) também são
//     reconhecidas pelo nome específico — e bloqueiam com UNIDADE_NAO_HABILITADA.
/** Palavras de cadastro que não identificam a loja ("Matriz Subway Centro", "Subway Saci — Matriz"). */
const PALAVRAS_DE_CADASTRO = new Set(["matriz", "filial"]);
export const nomeCanonico = (nome) => normalizar(nome).split(" ").filter((p) => p && !PALAVRAS_DE_CADASTRO.has(p)).join(" ");
const comecaCom = (nome, a) => nome !== a && nome.startsWith(`${a} `);
const contemPalavras = (nome, a) => ` ${nome} `.includes(` ${a} `);

/**
 * Apelidos que são MARCA (não identificam a loja sozinhos): o começo do próprio nome ("subway" de "subway saci") ou um
 * apelido que também aparece no nome de uma loja NÃO habilitada do cadastro ("alfa" × "loja alfa norte shopping") — um
 * apelido que outra loja também carrega no nome não distingue loja nenhuma.
 */
export function marcasDaUnidade(u, naoHabilitadas = []) {
  const nome = nomeCanonico(u.nome);
  const outros = naoHabilitadas.map((x) => nomeCanonico(x.nome));
  // O nome completo da própria loja nunca vira marca (a forma mais longa da não habilitada já vence quando é ela no texto).
  return (u.apelidos ?? []).filter((a) => a !== nome && (comecaCom(nome, a) || outros.some((o) => contemPalavras(o, a))));
}

/** Formas ESPECÍFICAS de cada loja (habilitada ou não), da mais longa para a mais curta, e as marcas conhecidas. */
function formasEspecificas(habilitadas, naoHabilitadas) {
  const marcas = [...new Set(habilitadas.flatMap((u) => marcasDaUnidade(u, naoHabilitadas)))];
  const formas = [];
  for (const u of habilitadas) {
    const daMarca = new Set(marcasDaUnidade(u, naoHabilitadas));
    for (const a of new Set([nomeCanonico(u.nome), ...u.apelidos])) if (a && !daMarca.has(a)) formas.push({ forma: a, unidade: u, habilitada: true });
  }
  const especificasHabilitadas = new Set(formas.map((f) => f.forma));
  // Loja não habilitada: o nome canônico e o LOCAL — as palavras do nome que ela NÃO divide com a loja habilitada mais parecida
  // ("north shopping", "rio poty"), só com 2+ palavras: "centro" ou "saci" sozinhos são comuns demais para identificar algo.
  for (const u of naoHabilitadas) {
    const nome = nomeCanonico(u.nome);
    const palavras = nome.split(" ").filter(Boolean);
    if (palavras.length < 2) continue;
    formas.push({ forma: nome, unidade: u, habilitada: false });
    const parecida = habilitadas.map((h) => new Set(nomeCanonico(h.nome).split(" "))).map((s) => ({ s, n: palavras.filter((p) => s.has(p)).length }))
      .sort((a, b) => b.n - a.n)[0];
    if (!parecida?.n) continue;
    const local = palavras.filter((p) => !parecida.s.has(p)).join(" ");
    if (local.split(" ").length >= 2 && contemPalavras(nome, local) && !especificasHabilitadas.has(local)) formas.push({ forma: local, unidade: u, habilitada: false });
  }
  return { formas: formas.sort((a, b) => b.forma.length - a.forma.length), marcas };
}

/**
 * Leitura de UM texto: lojas citadas pelo nome específico (habilitadas e não habilitadas) e as MARCAS citadas sem loja.
 * A forma mais longa vence ("subway north shopping" não deixa sobrar "subway" para a marca).
 */
export function citacoesDoTexto(texto, habilitadas, naoHabilitadas = []) {
  let t = ` ${normalizar(texto)} `;
  const fortes = new Map(), naoHab = new Map(), marcas = new Set();
  if (t.trim() === "") return { fortes, naoHab, marcas };
  const { formas, marcas: todasMarcas } = formasEspecificas(habilitadas, naoHabilitadas);
  for (const f of formas) {
    if (!t.includes(` ${f.forma} `)) continue;
    (f.habilitada ? fortes : naoHab).set(f.unidade.unidadeId, f.unidade);
    t = t.split(` ${f.forma} `).join(" | ");
  }
  for (const m of todasMarcas.sort((a, b) => b.length - a.length)) if (t.includes(` ${m} `)) { marcas.add(m); t = t.split(` ${m} `).join(" | "); }
  return { fortes, naoHab, marcas };
}

/**
 * @param {{cfg:object, grupo:{unidades:string[]}, textos:string[], documentoDestinatario?:string|null, sugestaoIa?:string|null}} p
 * @returns {{resultado:string, unidade:object|null, evidencia:string|null}}
 */
export function resolverUnidade({ cfg, grupo, textos, documentoDestinatario = null, sugestaoIa = null, pagador = null, documentoPagador = null, marcaBasta = false }) {
  const doGrupo = cfg.unidades.filter((u) => grupo.unidades.includes(u.unidadeId));
  const todas = cfg.unidades;
  const naoHabilitadas = cfg.unidadesNaoHabilitadas ?? [];
  const marcasDe = (u) => marcasDaUnidade(u, naoHabilitadas);
  // Documento: procura em TODAS as unidades configuradas, para detectar documento de unidade errada/fora do grupo.
  const doc = documentoDestinatario ? normalizarDocumento(documentoDestinatario) : "";
  const peloDocumento = doc ? todas.filter((u) => u.documentos.includes(doc)) : [];
  // 27/11: só o nome ESPECÍFICO da loja identifica; a MARCA sozinha só confirma (ou basta na resposta a "de qual unidade?").
  const leituras = textos.map((t) => citacoesDoTexto(t, todas, naoHabilitadas));
  const fortes = new Map(leituras.flatMap((l) => [...l.fortes]));
  const naoHab = new Map(leituras.flatMap((l) => [...l.naoHab]));
  const marcasCitadas = new Set(leituras.flatMap((l) => [...l.marcas]));
  const daMarca = todas.filter((u) => marcasDe(u).some((m) => marcasCitadas.has(m)));
  const sug = sugestaoIa ? citacoesDoTexto(sugestaoIa, todas, naoHabilitadas) : null;
  // Loja NÃO habilitada citada expressamente: bloqueia antes de qualquer outra evidência (pagador, CNPJ, grupo de uma loja),
  // para que nenhuma delas redirecione o documento para outra loja. Citada junto de uma loja habilitada: conflito (pergunta).
  if (naoHab.size) {
    if (fortes.size) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_CITA_NAO_HABILITADA_E_HABILITADA" };
    return { resultado: RESULTADO_UNIDADE.NAO_HABILITADA, unidade: null, evidencia: "TEXTO", unidadeDoDocumento: [...naoHab.values()].map((u) => u.nome).join(", ") };
  }
  if (sug?.naoHab.size && !fortes.size) return { resultado: RESULTADO_UNIDADE.NAO_HABILITADA, unidade: null, evidencia: "LEITURA_DO_DOCUMENTO", unidadeDoDocumento: [...sug.naoHab.values()].map((u) => u.nome).join(", ") };
  if (sug?.naoHab.size) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_IA" };
  // Marca citada sem loja: vale como referência só quando aponta UMA loja da conversa; de outra conversa ⇒ fora do grupo.
  const marcaNaConversa = daMarca.filter((u) => doGrupo.includes(u));
  if (!fortes.size && daMarca.length && !marcaNaConversa.length) return { resultado: RESULTADO_UNIDADE.FORA_DO_GRUPO, unidade: null, evidencia: "MARCA" };
  // Duas MARCAS diferentes da conversa ("a subway pagou o açaí") = cita várias (como antes); a mesma marca em duas lojas = sem referência.
  const marcasDistintas = new Set(marcaNaConversa.flatMap((u) => marcasDe(u).filter((m) => marcasCitadas.has(m))));
  const citadas = fortes.size ? [...fortes.values()] : marcaNaConversa.length === 1 || marcasDistintas.size > 1 ? marcaNaConversa : [];
  if (citadas.length > 1) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_CITA_VARIAS" };
  const citada = citadas[0] ?? null;
  const expressa = fortes.size > 0 || marcaBasta;
  const documentoDe = peloDocumento.length === 1 ? peloDocumento[0] : null;
  // 24/11: pagador (procura em TODAS as unidades, para detectar comprovante pago pela conta de outra unidade).
  const pg = (pagador || documentoPagador) ? unidadePeloPagador({ unidades: todas, pagador, documentoPagador }) : { resultado: RESULTADO_PAGADOR.SEM_EVIDENCIA, unidade: null };
  if (pg.resultado === RESULTADO_PAGADOR.CONFLITO) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: pg.evidencia };
  const pagadorDe = pg.unidade;
  if (pagadorDe && !doGrupo.includes(pagadorDe)) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "PAGADOR_FORA_DA_CONVERSA", unidadeDoDocumento: pagadorDe.nome };
  if (pagadorDe && citada && citada !== pagadorDe) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_PAGADOR" };
  if (pagadorDe && documentoDe && documentoDe !== pagadorDe) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "DOCUMENTO_X_PAGADOR" };

  if (citada && !doGrupo.includes(citada)) return { resultado: RESULTADO_UNIDADE.FORA_DO_GRUPO, unidade: null, evidencia: "TEXTO" };
  if (documentoDe && !doGrupo.includes(documentoDe)) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "DOCUMENTO_FORA_DO_GRUPO" };
  if (citada && documentoDe && citada !== documentoDe) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "TEXTO_X_DOCUMENTO" };

  // A sugestão da IA só CONFIRMA: pelo nome específico; sem ele, pela marca (marca de duas lojas da conversa não confirma nenhuma).
  const sugForte = sug ? [...sug.fortes.values()].filter((u) => doGrupo.includes(u)) : [];
  const sugerida = sugForte.length ? sugForte : sug ? doGrupo.filter((u) => marcasDe(u).some((m) => sug.marcas.has(m))) : [];
  const confirmaIa = (u) => sugerida.length === 0 || (sugerida.length === 1 && sugerida[0] === u) || (!sugForte.length && sugerida.includes(u));
  // Marca sozinha não identifica a loja (segue para pagador, documento ou conversa de uma loja); exceção: resposta a "de qual unidade?".
  if (citada && expressa) return confirmaIa(citada) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: citada, evidencia: "TEXTO" } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_IA" };
  if (pagadorDe) return confirmaIa(pagadorDe) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: pagadorDe, evidencia: pg.evidencia } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "PAGADOR_X_IA" };
  if (documentoDe) return confirmaIa(documentoDe) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: documentoDe, evidencia: "DOCUMENTO" } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "DOCUMENTO_X_IA" };
  if (doGrupo.length === 1) return confirmaIa(doGrupo[0]) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: doGrupo[0], evidencia: "GRUPO_DE_UMA_UNIDADE" } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "GRUPO_X_IA" };
  // Grupo compartilhado sem evidência própria: a sugestão da IA NÃO basta.
  return { resultado: RESULTADO_UNIDADE.NAO_IDENTIFICADA, unidade: null, evidencia: null };
}
