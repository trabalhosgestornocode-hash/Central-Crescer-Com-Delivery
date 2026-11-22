// CONFIGURAÇÃO do MOVA — grupos autorizados, unidades (com apelidos e fontes de faturamento) e a identidade de serviço.
//
// Princípios:
//   - Nenhum identificador real (JID de grupo, telefone, CNPJ, id de unidade) mora no código: tudo vem desta configuração,
//     montada a partir de dados da plataforma/ambiente no momento da montagem.
//   - Execução 02 (decisão do proprietário): NÍVEL 1 = todo participante de um grupo AUTORIZADO conversa com o MOVA, envia
//     documentos e cria PROPOSTAS, sem cadastro nem login. NÍVEL 2 (revisar/aprovar/aplicar) continua sendo só de usuário da
//     plataforma com as permissões financeiro_v2.* — pelo Centro Financeiro autenticado, nunca pelo WhatsApp.
//   - As consultas do MOVA ao Financeiro usam a IDENTIDADE DE SERVIÇO (`identidadeServico.usuarioId`), sempre só com "ver".
//   - Fontes de faturamento por unidade: sistema de loja (SAIPOS | SWF) + plataformas oficiais. Unidade sem fontes confirmadas
//     fica "A_CONFIRMAR" e nada de receita é proposto para ela.
//   - Modo: só "SIMULACAO" nesta execução (nenhuma escrita real, nenhuma resposta enviada ao WhatsApp).

/** SIMULACAO (padrão) ou HOMOLOGACAO (Execução 04B: admite UMA conversa privada de teste, além dos grupos). */
export const MODOS = Object.freeze(["SIMULACAO", "HOMOLOGACAO", "PILOTO"]);
/** 16A: conversa PRIVADA (1 pessoa) só na homologação e no piloto de consultas; nos demais modos, só grupos. */
export const aceitaConversaPrivada = (modo) => modo === "HOMOLOGACAO" || modo === "PILOTO";
const JID_PRIVADO = /^[1-9][0-9]{7,14}@s\.whatsapp\.net$/;
export const ehConversaPrivada = (jid) => JID_PRIVADO.test(String(jid ?? ""));
export const SITUACAO_FONTES = Object.freeze({ CONFIRMADA: "CONFIRMADA", A_CONFIRMAR: "A_CONFIRMAR" });
const SISTEMAS_DE_LOJA = ["SAIPOS", "SWF"];
const PLATAFORMAS = ["IFOOD", "NOVENTA_E_NOVE_FOOD"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRUPO = /^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$/;

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
  exigir(UUID.test(c.identidadeServico?.usuarioId ?? ""), "identidadeServico");
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
    exigir(GRUPO.test(g?.grupoId ?? "") || (aceitaConversaPrivada(c.modo) && JID_PRIVADO.test(g?.grupoId ?? "")), `gruposAutorizados[${i}].grupoId`);
    exigir(Array.isArray(g.unidades) && g.unidades.length > 0 && g.unidades.every((x) => ids.has(String(x).toLowerCase())), `gruposAutorizados[${i}].unidades`);
    return Object.freeze({ grupoId: g.grupoId, unidades: Object.freeze(g.unidades.map((x) => String(x).toLowerCase())) });
  });
  return Object.freeze({ modo: c.modo, identidadeServico: Object.freeze({ usuarioId: c.identidadeServico.usuarioId.toLowerCase() }), unidades: Object.freeze(unidades), gruposAutorizados: Object.freeze(grupos) });
}

export const grupoAutorizado = (cfg, grupoId) => cfg.gruposAutorizados.find((g) => g.grupoId === grupoId) ?? null;
/** Celular brasileiro: o WhatsApp pode identificar a mesma linha com ou sem o nono dígito (55+DDD+9+8 ⇄ 55+DDD+8). */
const variantesBr = (jid) => {
  const m = /^55([1-9][0-9])(9?)([6-9][0-9]{7})@s\.whatsapp\.net$/.exec(String(jid ?? ""));
  return m ? [`55${m[1]}9${m[3]}@s.whatsapp.net`, `55${m[1]}${m[3]}@s.whatsapp.net`] : [];
};
/** 15H: os dois JIDs privados são o MESMO celular brasileiro (com ou sem o nono dígito)? Iguais também valem. */
export const mesmoCelularBr = (a, b) => typeof a === "string" && typeof b === "string" && JID_PRIVADO.test(a) && JID_PRIVADO.test(b)
  && (a === b || variantesBr(a).includes(b));
/**
 * Conversa autorizada para o JID recebido: igualdade exata; para conversa PRIVADA (só nos modos HOMOLOGACAO e PILOTO), também a
 * variante com/sem nono dígito. Devolve a entrada CADASTRADA (o JID canônico usado em fila, unidades e participantes).
 */
export function conversaAutorizada(cfg, jid) {
  const exata = grupoAutorizado(cfg, jid);
  if (exata || !aceitaConversaPrivada(cfg.modo) || !ehConversaPrivada(jid)) return exata;
  const vs = variantesBr(jid);
  const achadas = cfg.gruposAutorizados.filter((g) => vs.includes(g.grupoId));
  return achadas.length === 1 ? achadas[0] : null; // ambíguo (as duas formas cadastradas) ⇒ nenhuma
}
export const unidadePorId = (cfg, id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
/** Requisitos financeiros completos para APLICAR propostas (hoje: fontes de faturamento confirmadas no cadastro). */
export const requisitosCompletos = (unidade) => unidade?.fontes?.situacao === SITUACAO_FONTES.CONFIRMADA;

/** Mascara um JID de grupo/participante para log: só os 4 últimos dígitos. */
export function mascarar(jid) {
  const s = String(jid ?? "");
  const dig = s.split("@")[0].replace(/\D/g, "");
  return dig ? `…${dig.slice(-4)}@${s.split("@")[1] ?? "?"}` : null;
}
