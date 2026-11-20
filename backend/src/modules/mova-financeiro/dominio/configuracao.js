// CONFIGURAÇÃO do MOVA — grupos autorizados, unidades (com apelidos e fontes de faturamento) e vínculos participante → usuário.
//
// Princípios:
//   - Nenhum identificador real (JID de grupo, telefone, CNPJ, id de unidade) mora no código: tudo vem desta configuração,
//     montada a partir de dados da plataforma/ambiente no momento da montagem.
//   - PARTICIPAR DO GRUPO NÃO DÁ ACESSO: só um participante com VÍNCULO explícito a um usuário da plataforma age, e mesmo assim
//     só com as permissões financeiras (financeiro_v2.*) que esse usuário tem NA unidade (lidas da concessão, não daqui).
//   - Fontes de faturamento por unidade: sistema de loja (SAIPOS | SWF) + plataformas oficiais. Unidade sem fontes confirmadas
//     fica "A_CONFIRMAR" e nada de receita é proposto para ela.
//   - Modo: só "SIMULACAO" nesta execução (nenhuma escrita real, nenhuma resposta enviada ao WhatsApp).

export const MODOS = Object.freeze(["SIMULACAO"]);
export const SITUACAO_FONTES = Object.freeze({ CONFIRMADA: "CONFIRMADA", A_CONFIRMAR: "A_CONFIRMAR" });
const SISTEMAS_DE_LOJA = ["SAIPOS", "SWF"];
const PLATAFORMAS = ["IFOOD", "NOVENTA_E_NOVE_FOOD"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRUPO = /^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$/;
const PARTICIPANTE = /^[A-Za-z0-9_.:@-]{1,160}$/;

export class ErroDeConfiguracao extends Error {
  constructor(campo) { super(`Configuração do MOVA inválida: ${campo}`); this.name = "ErroDeConfiguracao"; this.campo = campo; }
}
const exigir = (cond, campo) => { if (!cond) throw new ErroDeConfiguracao(campo); };

/** Texto comparável: sem acento, minúsculas, espaços simples. */
export const normalizar = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Identificador de documento (CNPJ etc.): só dígitos/letras, maiúsculas. */
export const normalizarDocumento = (t) => String(t ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

function validarFontes(f, i) {
  exigir(f && typeof f === "object", `unidades[${i}].fontes`);
  const situacao = f.situacao ?? SITUACAO_FONTES.A_CONFIRMAR;
  exigir(Object.values(SITUACAO_FONTES).includes(situacao), `unidades[${i}].fontes.situacao`);
  if (situacao === SITUACAO_FONTES.A_CONFIRMAR) return Object.freeze({ situacao, sistemaDeLoja: null, plataformas: Object.freeze([]), anotaAiPelaSaipos: false });
  exigir(SISTEMAS_DE_LOJA.includes(f.sistemaDeLoja), `unidades[${i}].fontes.sistemaDeLoja`);
  exigir(Array.isArray(f.plataformas) && f.plataformas.every((p) => PLATAFORMAS.includes(p)), `unidades[${i}].fontes.plataformas`);
  const anota = f.anotaAiPelaSaipos === true;
  exigir(!anota || f.sistemaDeLoja === "SAIPOS", `unidades[${i}].fontes.anotaAiPelaSaipos`);
  return Object.freeze({ situacao, sistemaDeLoja: f.sistemaDeLoja, plataformas: Object.freeze([...new Set(f.plataformas)]), anotaAiPelaSaipos: anota });
}

/**
 * @param {object} c
 * @returns {Readonly<object>} configuração normalizada e congelada
 */
export function validarConfiguracao(c) {
  exigir(c && typeof c === "object", "raiz");
  exigir(MODOS.includes(c.modo), "modo");
  exigir(Array.isArray(c.unidades) && c.unidades.length > 0, "unidades");
  const unidades = c.unidades.map((u, i) => {
    exigir(UUID.test(u?.organizacaoId ?? "") && UUID.test(u?.unidadeId ?? ""), `unidades[${i}].ids`);
    exigir(typeof u.nome === "string" && u.nome.trim(), `unidades[${i}].nome`);
    const apelidos = [u.nome, ...(Array.isArray(u.apelidos) ? u.apelidos : [])].map(normalizar).filter((a) => a.length >= 3);
    const documentos = (Array.isArray(u.documentos) ? u.documentos : []).map(normalizarDocumento).filter(Boolean);
    return Object.freeze({
      organizacaoId: u.organizacaoId.toLowerCase(), unidadeId: u.unidadeId.toLowerCase(), nome: u.nome.trim(),
      apelidos: Object.freeze([...new Set(apelidos)]), documentos: Object.freeze(documentos), fontes: validarFontes(u.fontes, i),
    });
  });
  exigir(new Set(unidades.map((u) => u.unidadeId)).size === unidades.length, "unidades.duplicadas");
  // Um apelido que aponta para duas unidades tornaria a identificação ambígua: recusado na montagem.
  const donoDoApelido = new Map();
  for (const u of unidades) for (const a of u.apelidos) {
    exigir(!donoDoApelido.has(a) || donoDoApelido.get(a) === u.unidadeId, `apelido_ambiguo`);
    donoDoApelido.set(a, u.unidadeId);
  }
  const ids = new Set(unidades.map((u) => u.unidadeId));
  exigir(Array.isArray(c.gruposAutorizados), "gruposAutorizados");
  const grupos = c.gruposAutorizados.map((g, i) => {
    exigir(GRUPO.test(g?.grupoId ?? ""), `gruposAutorizados[${i}].grupoId`);
    exigir(Array.isArray(g.unidades) && g.unidades.length > 0 && g.unidades.every((x) => ids.has(String(x).toLowerCase())), `gruposAutorizados[${i}].unidades`);
    return Object.freeze({ grupoId: g.grupoId, unidades: Object.freeze(g.unidades.map((x) => String(x).toLowerCase())) });
  });
  exigir(Array.isArray(c.vinculos), "vinculos");
  const vinculos = c.vinculos.map((v, i) => {
    exigir(PARTICIPANTE.test(v?.participanteId ?? ""), `vinculos[${i}].participanteId`);
    exigir(UUID.test(v.usuarioId ?? ""), `vinculos[${i}].usuarioId`);
    return Object.freeze({ participanteId: v.participanteId, usuarioId: v.usuarioId.toLowerCase() });
  });
  exigir(new Set(vinculos.map((v) => v.participanteId)).size === vinculos.length, "vinculos.duplicados");
  return Object.freeze({ modo: c.modo, unidades: Object.freeze(unidades), gruposAutorizados: Object.freeze(grupos), vinculos: Object.freeze(vinculos) });
}

export const grupoAutorizado = (cfg, grupoId) => cfg.gruposAutorizados.find((g) => g.grupoId === grupoId) ?? null;
export const unidadePorId = (cfg, id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
export const vinculoDe = (cfg, participanteId) => (participanteId ? cfg.vinculos.find((v) => v.participanteId === participanteId) ?? null : null);

/** Mascara um JID de grupo/participante para log: só os 4 últimos dígitos. */
export function mascarar(jid) {
  const s = String(jid ?? "");
  const dig = s.split("@")[0].replace(/\D/g, "");
  return dig ? `…${dig.slice(-4)}@${s.split("@")[1] ?? "?"}` : null;
}
