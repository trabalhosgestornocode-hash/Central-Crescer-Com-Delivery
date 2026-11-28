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
  // 26/11: comprovante pago pela conta de UMA unidade da conversa, citando OUTRA unidade da MESMA conversa (ex.: a Subway pagou
  // pelo Açaí). Não é identificação: o motor PERGUNTA se é operação entre empresas; sem tratamento, segue bloqueado como conflito.
  PAGO_POR_OUTRA_UNIDADE: "PAGO_POR_OUTRA_UNIDADE",
  // 27/11: o texto (ou a leitura do documento) cita EXPRESSAMENTE uma loja da mesma empresa que existe no cadastro da plataforma
  // mas NÃO está habilitada no MOVA. Bloqueia: nada é criado em nenhuma outra unidade.
  NAO_HABILITADA: "UNIDADE_NAO_HABILITADA",
});
/** 27/11: situação do cadastro de lojas da plataforma na configuração (null = não gerido: simulação/testes antigos). */
export const CADASTRO = Object.freeze({ CONSULTADO: "CONSULTADO", INDISPONIVEL: "INDISPONIVEL" });

/** Unidades citadas no texto (apelido inteiro, por palavra). */
export function unidadesCitadas(texto, unidades) {
  const t = ` ${normalizar(texto)} `;
  if (t.trim() === "") return [];
  return unidades.filter((u) => u.apelidos.some((a) => t.includes(` ${a} `)));
}

// 27/11 — MARCA × LOJA. Achado em produção: "<serviço> <marca> <outra loja da rede>" virou a loja habilitada da mesma marca,
// porque o apelido da MARCA (comum a toda a rede) bastava para identificar a loja. Regras:
//   - apelido que é o começo do nome da própria loja ("sanduba" de "sanduba centro"), ou que outra loja do cadastro também
//     carrega no nome, é MARCA: nunca identifica a loja sozinho;
//   - o nome completo e os demais apelidos são ESPECÍFICOS: identificam a loja (comparação exata);
//   - lojas das MESMAS empresas no cadastro e fora do MOVA (`cfg.unidadesNaoHabilitadas`) são reconhecidas pelo nome, pelo
//     LOCAL (palavras que não divide com a loja habilitada) ou por uma palavra distintiva dele — com tolerância a UM erro de
//     digitação em palavras longas — e bloqueiam (UNIDADE_NAO_HABILITADA);
//   - MARCA seguida de um qualificador de lugar que não é da loja habilitada ("<marca> shopping <cidade>") = loja DESCONHECIDA
//     (talvez nem cadastrada): pergunta, nunca assume;
//   - pagador, CNPJ e "conversa de uma loja" identificam a EMPRESA; só valem como identificação definitiva da LOJA quando o
//     cadastro foi CONSULTADO e a empresa tem só essa loja. Cadastro INDISPONÍVEL ⇒ só o nome específico identifica.
/** Palavras de cadastro que não identificam a loja ("Matriz <marca> Centro", "<loja> — Matriz"). */
const PALAVRAS_DE_CADASTRO = new Set(["matriz", "filial"]);
/** Qualificadores de LUGAR: depois da marca, indicam uma loja específica (se não for a habilitada, é outra loja). */
const QUALIFICADORES = ["shopping", "mall", "plaza", "center", "centro", "norte", "north", "sul", "south", "leste", "oeste", "avenida", "av", "rua", "bairro", "praia", "aeroporto", "outlet", "express", "park", "parque"];
/** Palavras comuns demais para identificar uma loja sozinhas (mesmo sendo parte do nome). */
const COMUNS = new Set([...QUALIFICADORES, "loja", "unidade", "delivery", "grau", "no", "na", "do", "da", "de", "dos", "das", "e", "city", "cidade", "vila", "jardim", "nova", "novo", "sao", "santa", "santo"]);
export const nomeCanonico = (nome) => normalizar(nome).split(" ").filter((p) => p && !PALAVRAS_DE_CADASTRO.has(p)).join(" ");
const comecaCom = (nome, a) => nome !== a && nome.startsWith(`${a} `);
const contemPalavras = (nome, a) => ` ${nome} `.includes(` ${a} `);
const palavras = (t) => normalizar(t).split(" ").filter(Boolean);

/** Distância de edição limitada a 1 (troca, falta ou sobra de UMA letra), só em palavras de 5+ letras. */
function quaseIgual(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, dif = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++dif > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return dif + (a.length - i) + (b.length - j) <= 1;
}
/** Posição da sequência de palavras `forma` em `texto` (com `tolerante`, um erro por palavra longa); -1 se não houver. */
function posicaoDaFrase(texto, forma, tolerante) {
  for (let i = 0; i + forma.length <= texto.length; i++) {
    if (forma.every((f, k) => (tolerante ? quaseIgual(texto[i + k], f) : texto[i + k] === f))) return i;
  }
  return -1;
}

/**
 * Apelidos que são MARCA (não identificam a loja sozinhos): o começo do próprio nome, ou um apelido que também aparece no nome
 * de uma loja NÃO habilitada do cadastro. O nome completo da própria loja nunca vira marca.
 */
export function marcasDaUnidade(u, naoHabilitadas = []) {
  const nome = nomeCanonico(u.nome);
  const outros = naoHabilitadas.map((x) => nomeCanonico(x.nome));
  return (u.apelidos ?? []).filter((a) => a !== nome && (comecaCom(nome, a) || outros.some((o) => contemPalavras(o, a))));
}

/** Formas de cada loja: específicas das habilitadas (exatas) e das não habilitadas (tolerantes), da mais longa à mais curta. */
function formasDasLojas(habilitadas, naoHabilitadas) {
  const marcas = [...new Set(habilitadas.flatMap((u) => marcasDaUnidade(u, naoHabilitadas)))];
  const formas = [];
  for (const u of habilitadas) {
    const daMarca = new Set(marcasDaUnidade(u, naoHabilitadas));
    for (const a of new Set([nomeCanonico(u.nome), ...u.apelidos])) if (a && !daMarca.has(a)) formas.push({ forma: a.split(" "), unidade: u, habilitada: true });
  }
  const especificas = new Set(formas.map((f) => f.forma.join(" ")));
  const palavrasHabilitadas = new Set(habilitadas.flatMap((u) => [nomeCanonico(u.nome), ...u.apelidos].flatMap((a) => a.split(" "))));
  for (const u of naoHabilitadas) {
    const nome = nomeCanonico(u.nome).split(" ").filter(Boolean);
    if (nome.length < 2) continue;
    formas.push({ forma: nome, unidade: u, habilitada: false });
    const parecida = habilitadas.map((h) => new Set(nomeCanonico(h.nome).split(" "))).map((s) => ({ s, n: nome.filter((p) => s.has(p)).length })).sort((a, b) => b.n - a.n)[0];
    if (!parecida?.n) continue;
    const local = nome.filter((p) => !parecida.s.has(p));
    if (local.length >= 2 && contemPalavras(nome.join(" "), local.join(" ")) && !especificas.has(local.join(" "))) formas.push({ forma: local, unidade: u, habilitada: false });
    // Abreviação: uma palavra DISTINTIVA do local com 5+ letras ("north"), nunca comum nem de loja habilitada.
    for (const p of local) if (p.length >= 5 && !COMUNS.has(p) && !palavrasHabilitadas.has(p)) formas.push({ forma: [p], unidade: u, habilitada: false });
  }
  return { formas: formas.sort((a, b) => b.forma.join(" ").length - a.forma.join(" ").length), marcas };
}

/**
 * Leitura de UM texto: lojas citadas (habilitadas e não habilitadas), MARCAS citadas sem loja e marca seguida de lugar que
 * não é da loja habilitada (loja DESCONHECIDA). A forma mais longa vence e consome as palavras.
 */
export function citacoesDoTexto(texto, habilitadas, naoHabilitadas = []) {
  const t = palavras(texto);
  const fortes = new Map(), naoHab = new Map(), marcas = new Set(), desconhecidas = new Set();
  if (!t.length) return { fortes, naoHab, marcas, desconhecidas };
  const { formas, marcas: todasMarcas } = formasDasLojas(habilitadas, naoHabilitadas);
  const consumir = (i, n) => { for (let k = i; k < i + n; k++) t[k] = "|"; };
  for (const f of formas) {
    for (let i = posicaoDaFrase(t, f.forma, !f.habilitada); i >= 0; i = posicaoDaFrase(t, f.forma, !f.habilitada)) {
      (f.habilitada ? fortes : naoHab).set(f.unidade.unidadeId, f.unidade);
      consumir(i, f.forma.length);
    }
  }
  for (const m of todasMarcas.map((x) => x.split(" ")).sort((a, b) => b.length - a.length)) {
    for (let i = posicaoDaFrase(t, m, false); i >= 0; i = posicaoDaFrase(t, m, false)) {
      marcas.add(m.join(" "));
      if (t.slice(i + m.length, i + m.length + 3).some((p) => QUALIFICADORES.some((q) => quaseIgual(p, q)))) desconhecidas.add(m.join(" "));
      consumir(i, m.length);
    }
  }
  return { fortes, naoHab, marcas, desconhecidas };
}

/**
 * @param {{cfg:object, grupo:{unidades:string[]}, textos:string[], documentoDestinatario?:string|null, sugestaoIa?:string|null,
 *          pagador?:string|null, documentoPagador?:string|null, marcaBasta?:boolean, somenteLeitura?:boolean}} p
 *   marcaBasta: resposta a "de qual unidade?" — a marca basta se NÃO houver outra loja conhecida da mesma marca.
 *   somenteLeitura: consulta — a marca basta entre as lojas da conversa (nada é gravado).
 * @returns {{resultado:string, unidade:object|null, evidencia:string|null}}
 */
export function resolverUnidade({ cfg, grupo, textos, documentoDestinatario = null, sugestaoIa = null, pagador = null, documentoPagador = null, marcaBasta = false, somenteLeitura = false }) {
  const doGrupo = cfg.unidades.filter((u) => grupo.unidades.includes(u.unidadeId));
  const todas = cfg.unidades;
  const naoHabilitadas = cfg.unidadesNaoHabilitadas ?? [];
  const cadastro = cfg.cadastroDeUnidades ?? null; // null = não gerido (simulação/testes antigos): evidência como antes
  const marcasDe = (u) => marcasDaUnidade(u, naoHabilitadas);
  // Documento: procura em TODAS as unidades configuradas, para detectar documento de unidade errada/fora do grupo.
  const doc = documentoDestinatario ? normalizarDocumento(documentoDestinatario) : "";
  const peloDocumento = doc ? todas.filter((u) => u.documentos.includes(doc)) : [];
  const leituras = textos.map((t) => citacoesDoTexto(t, todas, naoHabilitadas));
  const fortes = new Map(leituras.flatMap((l) => [...l.fortes]));
  const naoHab = new Map(leituras.flatMap((l) => [...l.naoHab]));
  const marcasCitadas = new Set(leituras.flatMap((l) => [...l.marcas]));
  const desconhecida = leituras.some((l) => l.desconhecidas.size);
  const daMarca = todas.filter((u) => marcasDe(u).some((m) => marcasCitadas.has(m)));
  const sug = sugestaoIa ? citacoesDoTexto(sugestaoIa, todas, naoHabilitadas) : null;
  // Loja NÃO habilitada citada: bloqueia antes de qualquer outra evidência (pagador, CNPJ, conversa de uma loja), para que
  // nenhuma delas redirecione o documento para outra loja. Citada junto de uma loja habilitada: conflito (pergunta).
  if (naoHab.size) {
    if (fortes.size) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_CITA_NAO_HABILITADA_E_HABILITADA" };
    return { resultado: RESULTADO_UNIDADE.NAO_HABILITADA, unidade: null, evidencia: "TEXTO", unidadeDoDocumento: [...naoHab.values()].map((u) => u.nome).join(", ") };
  }
  if (sug?.naoHab.size && !fortes.size) return { resultado: RESULTADO_UNIDADE.NAO_HABILITADA, unidade: null, evidencia: "LEITURA_DO_DOCUMENTO", unidadeDoDocumento: [...sug.naoHab.values()].map((u) => u.nome).join(", ") };
  if (sug?.naoHab.size) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_IA" };
  // Marca + lugar que não é da loja habilitada: loja desconhecida (pode nem estar cadastrada). Sem o nome específico, pergunta.
  if (desconhecida && !fortes.size && !somenteLeitura) return { resultado: RESULTADO_UNIDADE.NAO_IDENTIFICADA, unidade: null, evidencia: "LOJA_DESCONHECIDA" };
  // Marca citada sem loja: vale como referência só quando aponta UMA loja da conversa; de outra conversa ⇒ fora do grupo.
  const marcaNaConversa = daMarca.filter((u) => doGrupo.includes(u));
  if (!fortes.size && daMarca.length && !marcaNaConversa.length) return { resultado: RESULTADO_UNIDADE.FORA_DO_GRUPO, unidade: null, evidencia: "MARCA" };
  // Duas MARCAS diferentes da conversa ("a <marca A> pagou a <marca B>") = cita várias; a mesma marca em duas lojas = sem referência.
  const marcasDistintas = new Set(marcaNaConversa.flatMap((u) => marcasDe(u).filter((m) => marcasCitadas.has(m))));
  const citadasBrutas = fortes.size ? [...fortes.values()] : marcaNaConversa.length === 1 || marcasDistintas.size > 1 ? marcaNaConversa : [];
  // 24/11: pagador (procura em TODAS as unidades, para detectar comprovante pago pela conta de outra unidade).
  const pg = (pagador || documentoPagador) ? unidadePeloPagador({ unidades: todas, pagador, documentoPagador }) : { resultado: RESULTADO_PAGADOR.SEM_EVIDENCIA, unidade: null };
  // 27/11 (homologação real): "<devedora>, pago pela <credora>" cita as DUAS lojas. Se o comprovante identifica como pagadora UMA
  // das duas citadas, a outra é a devedora — é a operação entre empresas, não um conflito de unidade. Com mais de duas citadas, ou
  // sem a pagadora entre elas, continua sendo conflito (pergunta).
  const entreAsCitadas = citadasBrutas.length === 2 && pg.resultado !== RESULTADO_PAGADOR.CONFLITO && Boolean(pg.unidade) && citadasBrutas.includes(pg.unidade);
  const citadas = entreAsCitadas ? citadasBrutas.filter((u) => u !== pg.unidade) : citadasBrutas;
  if (citadas.length > 1) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_CITA_VARIAS" };
  const citada = citadas[0] ?? null;
  // A marca só resolve "de qual unidade?" quando o cadastro foi lido e nenhuma OUTRA loja conhecida tem a mesma marca.
  const marcaInequivoca = (u) => cadastro !== CADASTRO.INDISPONIVEL && marcasDe(u).filter((m) => marcasCitadas.has(m))
    .every((m) => todas.filter((x) => marcasDe(x).includes(m)).length === 1 && !naoHabilitadas.some((x) => contemPalavras(nomeCanonico(x.nome), m)));
  const expressa = fortes.size > 0 || Boolean(citada && (somenteLeitura || (marcaBasta && marcaInequivoca(citada))));
  // Pagador/CNPJ/conversa de uma loja identificam a EMPRESA; a LOJA só quando o cadastro foi consultado e a empresa só tem ela.
  const lojaUnicaDaEmpresa = (u) => cadastro === null || (cadastro === CADASTRO.CONSULTADO && !naoHabilitadas.some((x) => x.organizacaoId === u.organizacaoId));
  const documentoDe = peloDocumento.length === 1 ? peloDocumento[0] : null;
  if (pg.resultado === RESULTADO_PAGADOR.CONFLITO) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: pg.evidencia };
  const pagadorDe = pg.unidade;
  if (pagadorDe && !doGrupo.includes(pagadorDe)) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "PAGADOR_FORA_DA_CONVERSA", unidadeDoDocumento: pagadorDe.nome };
  if (pagadorDe && citada && citada !== pagadorDe) {
    // as duas na conversa (a pagadora já foi conferida acima): possível operação entre empresas — `unidade` = a citada (devedora)
    // 27/11 (#238): a DEVEDORA tem de ser precisa — nome específico da loja, ou marca sem outra loja conhecida com ela;
    // marca ambígua (ou cadastro indisponível) nunca vira operação entre empresas: pergunta.
    const devedoraPrecisa = fortes.size > 0 || marcaInequivoca(citada);
    if (doGrupo.includes(citada) && !(documentoDe && documentoDe !== citada)) {
      return devedoraPrecisa ? { resultado: RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE, unidade: citada, pagadora: pagadorDe, evidencia: "TEXTO_X_PAGADOR" }
        : { resultado: RESULTADO_UNIDADE.NAO_IDENTIFICADA, unidade: null, evidencia: "DEVEDORA_NAO_PRECISA" };
    }
    return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_PAGADOR" };
  }
  if (pagadorDe && documentoDe && documentoDe !== pagadorDe) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "DOCUMENTO_X_PAGADOR" };

  if (citada && !doGrupo.includes(citada)) return { resultado: RESULTADO_UNIDADE.FORA_DO_GRUPO, unidade: null, evidencia: "TEXTO" };
  if (documentoDe && !doGrupo.includes(documentoDe)) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "DOCUMENTO_FORA_DO_GRUPO" };
  if (citada && documentoDe && citada !== documentoDe) return { resultado: RESULTADO_UNIDADE.DOCUMENTO_DE_OUTRA_UNIDADE, unidade: null, evidencia: "TEXTO_X_DOCUMENTO" };

  // A sugestão da IA só CONFIRMA: pelo nome específico; sem ele, pela marca (marca de duas lojas da conversa não confirma nenhuma).
  const sugForte = sug ? [...sug.fortes.values()].filter((u) => doGrupo.includes(u)) : [];
  const sugerida = sugForte.length ? sugForte : sug ? doGrupo.filter((u) => marcasDe(u).some((m) => sug.marcas.has(m))) : [];
  const confirmaIa = (u) => sugerida.length === 0 || (sugerida.length === 1 && sugerida[0] === u) || (!sugForte.length && sugerida.includes(u));
  const naoDefinitiva = { resultado: RESULTADO_UNIDADE.NAO_IDENTIFICADA, unidade: null, evidencia: "EMPRESA_COM_VARIAS_LOJAS" };
  if (citada && expressa) return confirmaIa(citada) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: citada, evidencia: "TEXTO" } : { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "TEXTO_X_IA" };
  if (pagadorDe) {
    if (!confirmaIa(pagadorDe)) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "PAGADOR_X_IA" };
    return lojaUnicaDaEmpresa(pagadorDe) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: pagadorDe, evidencia: pg.evidencia } : naoDefinitiva;
  }
  if (documentoDe) {
    if (!confirmaIa(documentoDe)) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "DOCUMENTO_X_IA" };
    return lojaUnicaDaEmpresa(documentoDe) ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: documentoDe, evidencia: "DOCUMENTO" } : naoDefinitiva;
  }
  if (doGrupo.length === 1) {
    if (!confirmaIa(doGrupo[0])) return { resultado: RESULTADO_UNIDADE.CONFLITANTE, unidade: null, evidencia: "GRUPO_X_IA" };
    return lojaUnicaDaEmpresa(doGrupo[0]) || somenteLeitura ? { resultado: RESULTADO_UNIDADE.IDENTIFICADA, unidade: doGrupo[0], evidencia: "GRUPO_DE_UMA_UNIDADE" } : naoDefinitiva;
  }
  // Grupo compartilhado sem evidência própria: a sugestão da IA NÃO basta.
  return { resultado: RESULTADO_UNIDADE.NAO_IDENTIFICADA, unidade: null, evidencia: null };
}

/**
 * 27/11: REVALIDA a unidade de uma proposta antes de executá-la ou aprová-la (o cadastro e as regras podem ter mudado depois
 * que ela foi criada). Usa só o que a proposta guardou: texto da mensagem, leitura do documento e a conversa.
 * @returns {{ok:boolean, motivo:string|null, contradiz:boolean}} contradiz = a evidência aponta OUTRA loja (nunca aprovar);
 *   !ok && !contradiz = evidência insuficiente (a execução automática para; uma pessoa no Centro Financeiro pode confirmar).
 */
export function revalidarUnidadeDaProposta({ cfg, proposta, evento = null }) {
  const habilitada = cfg.unidades.find((u) => u.unidadeId === proposta.unidadeId);
  if (!habilitada) return { ok: false, motivo: "UNIDADE_FORA_DO_MOVA", contradiz: true };
  const conversa = cfg.gruposAutorizados?.find((g) => g.grupoId === (evento?.grupoId ?? evento?.grupo_jid)) ?? null;
  const grupo = { unidades: conversa?.unidades ?? [proposta.unidadeId] };
  const l = proposta.leitura ?? {};
  const textos = [evento?.texto].filter(Boolean);
  const r = resolverUnidade({ cfg, grupo, textos, documentoDestinatario: l.documentoDestinatario ?? null, sugestaoIa: l.unidadeSugerida ?? null,
    pagador: l.pagador ?? null, documentoPagador: l.documentoPagador ?? null });
  if (r.resultado === RESULTADO_UNIDADE.IDENTIFICADA) return r.unidade.unidadeId === proposta.unidadeId ? { ok: true, motivo: null, contradiz: false } : { ok: false, motivo: "UNIDADE_DIVERGENTE", contradiz: true };
  // Operação entre empresas (PR #236): a proposta é da DEVEDORA e o comando guarda a CREDORA (pagadora). Vale se as duas continuam
  // as mesmas; qualquer troca é contradição.
  if (r.resultado === RESULTADO_UNIDADE.PAGO_POR_OUTRA_UNIDADE) {
    const credora = proposta.comando?.credora?.unidadeId ?? null;
    const mesma = r.unidade.unidadeId === proposta.unidadeId && (!credora || credora === r.pagadora.unidadeId);
    // 28/11: nota/boleto em nome da empresa da OUTRA loja da conversa, com a unidade CONFIRMADA por quem é FINANCEIRO nas duas
    // (motor: confirmarUnidadeDoTomador). Vale só para uma das DUAS lojas do conflito e só com a confirmação registrada.
    const confirmada = proposta.esclarecidoPor && ["TEXTO_CONFIRMADO_CONTRA_TOMADOR", "TOMADOR_CONFIRMADO_CONTRA_TEXTO"].includes(l.evidenciaUnidade);
    if (confirmada) {
      const alvo = l.evidenciaUnidade === "TEXTO_CONFIRMADO_CONTRA_TOMADOR" ? r.unidade : r.pagadora;
      return alvo?.unidadeId === proposta.unidadeId ? { ok: true, motivo: null, contradiz: false } : { ok: false, motivo: "UNIDADE_DIVERGENTE", contradiz: true };
    }
    return mesma ? { ok: true, motivo: null, contradiz: false } : { ok: false, motivo: "ENTRE_EMPRESAS_DIVERGENTE", contradiz: true };
  }
  if (r.resultado === RESULTADO_UNIDADE.NAO_IDENTIFICADA) {
    // A unidade foi ESCOLHIDA por uma pessoa (resposta a "de qual unidade?"): vale, desde que nada a contradiga.
    if (proposta.esclarecidoPor) return { ok: true, motivo: null, contradiz: false };
    return { ok: false, motivo: `UNIDADE_NAO_CONFIRMADA:${r.evidencia ?? "SEM_EVIDENCIA"}`, contradiz: false };
  }
  return { ok: false, motivo: r.resultado, contradiz: true };
}
