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

/**
 * SIMULACAO (padrão) ou HOMOLOGACAO (Execução 04B: admite UMA conversa privada de teste, além dos grupos), PILOTO (16A) e
 * OPERACAO (Agente 2 — grupos reais): todo grupo com acesso por LISTA de participantes; conversas privadas só as DERIVADAS
 * dessa lista (a pessoa autorizada no grupo, com as unidades dela); nunca uma conversa privada avulsa.
 */
export const MODOS = Object.freeze(["SIMULACAO", "HOMOLOGACAO", "PILOTO", "OPERACAO"]);
/** 16A: conversa PRIVADA (1 pessoa) só na homologação e no piloto de consultas; nos demais modos, só grupos. */
export const aceitaConversaPrivada = (modo) => modo === "HOMOLOGACAO" || modo === "PILOTO";
/** Conversa privada pode ser ENDEREÇADA (resposta) neste modo? OPERACAO: só as derivadas dos participantes. */
export const aceitaConversaPrivadaDerivada = (modo) => modo === "OPERACAO";
const JID_PRIVADO = /^[1-9][0-9]{7,14}@s\.whatsapp\.net$/;
export const ehConversaPrivada = (jid) => JID_PRIVADO.test(String(jid ?? ""));
export const SITUACAO_FONTES = Object.freeze({ CONFIRMADA: "CONFIRMADA", A_CONFIRMAR: "A_CONFIRMAR" });
const SISTEMAS_DE_LOJA = ["SAIPOS", "SWF"];
const PLATAFORMAS = ["IFOOD", "NOVENTA_E_NOVE_FOOD"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRUPO = /^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$/;
import { ACESSO, POLITICA_RESPOSTA, conversasPrivadasDerivadas, validarParticipantes } from "./participantes.js";
import { CONSULTAS } from "../ia/contratos.js";
import { conversasDosEntregadores, validarEntregadores } from "./entregadores.js";
import { nomeCorresponde, validarPagadores } from "./pagador.js";

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
      empresa: typeof u.empresa === "string" && u.empresa.trim() ? u.empresa.trim().slice(0, 120) : null,
      apelidos: Object.freeze([...new Set(apelidos)]), documentos: Object.freeze(documentos), fontes: validarFontes(u.fontes, i),
      // 24/11 (0015): titulares/documentos da CONTA PAGADORA da unidade (identificam a unidade pelo comprovante; dominio/pagador.js).
      pagadores: validarPagadores(u.pagadores, { exigir, campo: `unidades[${i}].pagadores` }),
      // 23/11 (0014): unidade atendida SEM grupo (só OPERACAO). Nunca aparece em grupo; não gera conversa por si.
      ...(u.semGrupo === true ? { semGrupo: true } : {}),
    });
  });
  // Um mesmo pagador (nome ou documento) em duas unidades tornaria a identificação ambígua: recusado na montagem.
  for (const [i, u] of unidades.entries()) for (const v of unidades.slice(i + 1)) {
    exigir(!u.pagadores.documentos.some((d) => v.pagadores.documentos.includes(d)), "pagador_ambiguo");
    exigir(!u.pagadores.nomes.some((n) => v.pagadores.nomes.some((m) => nomeCorresponde(n, m) || nomeCorresponde(m, n))), "pagador_ambiguo");
  }
  exigir(new Set(unidades.map((u) => u.unidadeId)).size === unidades.length, "unidades.duplicadas");
  // Um apelido que aponta para duas unidades tornaria a identificação ambígua: recusado na montagem.
  const donoDoApelido = new Map();
  for (const u of unidades) for (const a of u.apelidos) {
    exigir(!donoDoApelido.has(a) || donoDoApelido.get(a) === u.unidadeId, `apelido_ambiguo`);
    donoDoApelido.set(a, u.unidadeId);
  }
  const ids = new Set(unidades.map((u) => u.unidadeId));
  exigir(Array.isArray(c.gruposAutorizados), "gruposAutorizados");
  const operacao = c.modo === "OPERACAO";
  const grupos = c.gruposAutorizados.filter((g) => !g?.derivada).map((g, i) => {
    const campo = `gruposAutorizados[${i}]`;
    exigir(GRUPO.test(g?.grupoId ?? "") || (aceitaConversaPrivada(c.modo) && JID_PRIVADO.test(g?.grupoId ?? "")), `${campo}.grupoId`);
    exigir(Array.isArray(g.unidades) && g.unidades.length > 0 && g.unidades.every((x) => ids.has(String(x).toLowerCase())), `${campo}.unidades`);
    const doGrupo = g.unidades.map((x) => String(x).toLowerCase());
    // Agente 2: acesso por LISTA (obrigatório na OPERACAO); ABERTO = Nível 1 da Execução 02 (só fora da operação real).
    const acesso = g.acesso ?? (operacao ? ACESSO.LISTA : ACESSO.ABERTO);
    exigir(Object.values(ACESSO).includes(acesso) && (!operacao || acesso === ACESSO.LISTA), `${campo}.acesso`);
    const participantes = acesso === ACESSO.LISTA ? validarParticipantes(g.participantes ?? [], { unidadesDoGrupo: doGrupo, campo, exigir }) : Object.freeze([]);
    exigir(acesso !== ACESSO.LISTA || participantes.length > 0, `${campo}.participantes`);
    const consultasNoGrupo = Array.isArray(g.consultasNoGrupo) ? g.consultasNoGrupo : [];
    exigir(consultasNoGrupo.every((x) => CONSULTAS.includes(x) && x !== "DADO_RESTRITO"), `${campo}.consultasNoGrupo`);
    const politicaResposta = g.politicaResposta ?? POLITICA_RESPOSTA.PRIVADO_RESTRITO;
    exigir(Object.values(POLITICA_RESPOSTA).includes(politicaResposta) && (politicaResposta === POLITICA_RESPOSTA.PRIVADO_RESTRITO || acesso === ACESSO.LISTA), `${campo}.politicaResposta`);
    // 25/11: grupo COMPARTILHADO por duas empresas só com a marca explícita `multiempresa` (cadastro auditável). Cada mensagem
    // continua resolvendo UMA unidade (titular/CNPJ do comprovante, apelido, pergunta) e o escopo nunca junta organizações.
    const orgsDoGrupo = new Set(doGrupo.map((x) => unidades.find((u) => u.unidadeId === x)?.organizacaoId));
    exigir(g.multiempresa == null || typeof g.multiempresa === "boolean", `${campo}.multiempresa`);
    // (unidade cadastrada SEM grupo dentro de um grupo é recusada adiante, com o motivo próprio "unidades.semGrupo")
    exigir(orgsDoGrupo.size === 1 || g.multiempresa === true || !g.grupoId.endsWith("@g.us") || doGrupo.some((x) => unidades.find((u) => u.unidadeId === x)?.semGrupo), `${campo}.multiempresa`);
    return Object.freeze({ grupoId: g.grupoId, unidades: Object.freeze(doGrupo), acesso, participantes, multiempresa: orgsDoGrupo.size > 1, consultasNoGrupo: Object.freeze([...consultasNoGrupo]), politicaResposta, privada: !g.grupoId.endsWith("@g.us"), derivada: false });
  });
  exigir(new Set(grupos.map((g) => g.grupoId)).size === grupos.length, "gruposAutorizados.duplicados");
  exigir(unidades.every((u) => !u.semGrupo || (operacao && !grupos.some((g) => g.unidades.includes(u.unidadeId)))), "unidades.semGrupo");
  // OPERACAO: as conversas privadas nascem da lista de participantes (nunca cadastradas à parte).
  // Uma conversa privada nunca mistura ORGANIZAÇÕES: a pessoa em grupos de duas empresas fica sem conversa privada derivada
  // (a resposta com valores não sai no grupo e ela é orientada a falar com o administrador). Isolamento antes de conveniência.
  const orgDe = new Map(unidades.map((u) => [u.unidadeId, u.organizacaoId]));
  // 24/11 (0015): unidade SEM grupo pode ter participantes AUTORIZADOS (cadastro da unidade): eles ganham a unidade na conversa
  // privada derivada. Conversa com duas ORGANIZAÇÕES só quando a unidade acrescentada marcou o acesso como MULTIEMPRESA
  // (autorização explícita e auditável no cadastro): no máximo UMA organização pode vir de acesso não marcado.
  const semGrupo = operacao ? (c.unidades ?? []).flatMap((u, i) => {
    if (u?.semGrupo !== true || u.participantes == null) return [];
    const unidadeId = String(u.unidadeId).toLowerCase();
    const participantes = validarParticipantes(u.participantes, { unidadesDoGrupo: [unidadeId], campo: `unidades[${i}]`, exigir });
    exigir(u.acessoMultiempresa == null || typeof u.acessoMultiempresa === "boolean", `unidades[${i}].acessoMultiempresa`);
    return participantes.length ? [{ unidadeId, participantes, multiempresa: u.acessoMultiempresa === true }] : [];
  }) : [];
  // Unidades com acesso multiempresa explícito: a sem grupo marcada e as de um grupo compartilhado marcado (25/11).
  const multiempresa = new Set([...semGrupo.filter((x) => x.multiempresa).map((x) => x.unidadeId), ...grupos.filter((g) => g.multiempresa).flatMap((g) => g.unidades)]);
  const permitida = (g) => {
    const orgs = new Set(g.unidades.map((u) => orgDe.get(u)));
    if (orgs.size === 1) return true;
    const naoMarcadas = new Set(g.unidades.filter((u) => !multiempresa.has(u)).map((u) => orgDe.get(u)));
    return naoMarcadas.size <= 1;
  };
  const derivadas = operacao ? conversasPrivadasDerivadas(grupos, semGrupo).filter((g) => permitida(g) && !grupos.some((x) => x.grupoId === g.grupoId)) : [];
  // Agente 2 — Frente D: entregadores (só na OPERACAO), cada um numa unidade do MOVA e na organização dela.
  let entregadores = [];
  try { entregadores = operacao ? validarEntregadores(c.entregadores ?? []) : []; } catch (e) { exigir(false, `entregadores.${e.message}`); }
  for (const [i, e] of entregadores.entries()) exigir(orgDe.has(e.unidadeId) && (!e.organizacaoId || orgDe.get(e.unidadeId) === e.organizacaoId), `entregadores[${i}].unidade`);
  entregadores = Object.freeze(entregadores.map((e) => Object.freeze({ ...e, organizacaoId: orgDe.get(e.unidadeId) })));
  const ocupados = new Set([...grupos, ...derivadas].map((g) => g.grupoId));
  const dosEntregadores = conversasDosEntregadores(entregadores, { ocupados });
  return Object.freeze({ modo: c.modo, identidadeServico: Object.freeze({ usuarioId: c.identidadeServico.usuarioId.toLowerCase() }), unidades: Object.freeze(unidades),
    gruposAutorizados: Object.freeze([...grupos, ...derivadas, ...dosEntregadores]), entregadores,
    unidadesNaoHabilitadas: normalizarNaoHabilitadas(c.unidadesNaoHabilitadas, unidades), cadastroDeUnidades: situacaoDoCadastro(c.cadastroDeUnidades) });
}

/** 27/11: situação do cadastro de lojas: CONSULTADO | INDISPONIVEL | null (não gerido — simulação/testes antigos). */
const situacaoDoCadastro = (s) => (s === "CONSULTADO" || s === "INDISPONIVEL" ? s : null);
/**
 * 27/11: lojas das MESMAS empresas que estão no cadastro da plataforma e não no MOVA (só para reconhecer e BLOQUEAR um
 * documento delas; nunca dão acesso, conversa ou escopo). Entrada inválida é descartada; habilitada nunca entra aqui.
 */
export function normalizarNaoHabilitadas(lista, unidades) {
  const orgs = new Set(unidades.map((u) => u.organizacaoId));
  const ids = new Set(unidades.map((u) => u.unidadeId));
  return Object.freeze((Array.isArray(lista) ? lista : [])
    .filter((u) => UUID.test(u?.unidadeId ?? "") && UUID.test(u?.organizacaoId ?? "") && typeof u.nome === "string" && u.nome.trim())
    .map((u) => ({ unidadeId: u.unidadeId.toLowerCase(), organizacaoId: u.organizacaoId.toLowerCase(), nome: u.nome.trim().slice(0, 120) }))
    .filter((u) => orgs.has(u.organizacaoId) && !ids.has(u.unidadeId))
    .map((u) => Object.freeze(u)));
}

/**
 * 23/11: CONFIGURAÇÃO VIVA. Antes, o cadastro de um entregador só valia depois de reiniciar o MOVA: a lista e as conversas
 * privadas dele eram montadas uma vez, na subida. Agora só ESSA parte é trocada em funcionamento — mesma validação
 * (validarConfiguracao) e só se TODO o resto (unidades, grupos, participantes) estiver idêntico; qualquer outra mudança
 * continua exigindo reinício. Quem lê `cfg.gruposAutorizados` / `cfg.entregadores` passa a ver a lista nova na hora; o número
 * antigo sai da lista de conversas (e dos destinos do envio) no mesmo instante.
 */
export function configuracaoViva(inicial, { recarregar = null, validadeMs = 60_000, relogio = () => Date.now() } = {}) {
  let atual = inicial;
  let lidoEm = relogio();
  // 27/11: o cadastro de lojas é trocado à parte (trocarCadastro); não conta como "outra mudança" na troca dos entregadores.
  const semEntregadores = (c) => JSON.stringify({ ...c, entregadores: null, gruposAutorizados: c.gruposAutorizados.filter((g) => !g.entregador), unidadesNaoHabilitadas: null, cadastroDeUnidades: null });
  function trocarEntregadores(nova) {
    if (semEntregadores(nova) !== semEntregadores(atual)) return { trocado: false, motivo: "OUTRAS_MUDANCAS_EXIGEM_REINICIO" };
    const mudou = JSON.stringify(nova.entregadores) !== JSON.stringify(atual.entregadores);
    // o cadastro de lojas em vigor continua o atual (é trocado só por trocarCadastro)
    atual = Object.freeze({ ...nova, unidadesNaoHabilitadas: atual.unidadesNaoHabilitadas, cadastroDeUnidades: atual.cadastroDeUnidades });
    return { trocado: mudou };
  }
  /** 27/11: troca SÓ o cadastro de lojas (atualização periódica), com a mesma normalização da configuração. */
  function trocarCadastro({ lista, situacao }) {
    atual = Object.freeze({ ...atual, unidadesNaoHabilitadas: normalizarNaoHabilitadas(lista ?? atual.unidadesNaoHabilitadas, atual.unidades), cadastroDeUnidades: situacaoDoCadastro(situacao) });
    return { situacao: atual.cadastroDeUnidades, total: atual.unidadesNaoHabilitadas.length };
  }
  const viva = {};
  for (const k of Object.keys(inicial)) Object.defineProperty(viva, k, { enumerable: true, get: () => atual[k] });
  /** Relê a lista do banco (forçado, ou se a leitura passou da validade). Falha de leitura mantém a lista atual. */
  Object.defineProperty(viva, "recarregarEntregadores", { enumerable: false, value: async ({ forcar = false } = {}) => {
    if (!recarregar) return { trocado: false, motivo: "SEM_RECARGA" };
    if (!forcar && relogio() - lidoEm < validadeMs) return { trocado: false, motivo: "DENTRO_DA_VALIDADE" };
    lidoEm = relogio();
    return trocarEntregadores(await recarregar());
  } });
  Object.defineProperty(viva, "trocarEntregadores", { enumerable: false, value: trocarEntregadores });
  Object.defineProperty(viva, "trocarCadastro", { enumerable: false, value: trocarCadastro });
  return Object.freeze(viva);
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
  if (exata || !(aceitaConversaPrivada(cfg.modo) || aceitaConversaPrivadaDerivada(cfg.modo)) || !ehConversaPrivada(jid)) return exata;
  const vs = variantesBr(jid);
  const achadas = cfg.gruposAutorizados.filter((g) => vs.includes(g.grupoId));
  return achadas.length === 1 ? achadas[0] : null; // ambíguo (as duas formas cadastradas) ⇒ nenhuma
}
export const unidadePorId = (cfg, id) => cfg.unidades.find((u) => u.unidadeId === id) ?? null;
/** Requisitos financeiros completos para APLICAR propostas (hoje: fontes de faturamento confirmadas no cadastro). */
export const requisitosCompletos = (unidade) => unidade?.fontes?.situacao === SITUACAO_FONTES.CONFIRMADA;
/**
 * 26/11 — as FONTES DE FATURAMENTO a confirmar só importam para o que toca RECEITA. Despesa, conta a pagar, baixa, vínculo de documento
 * e intercompany não dependem delas: bloquear essas operações (e dizer "a proposta fica guardada" depois de já executada) era um
 * falso impedimento. O MOVA nunca lança receita; qualquer tipo fora desta lista continua exigindo os requisitos.
 */
export const TIPOS_SEM_DEPENDENCIA_DE_FONTES = Object.freeze(["DESPESA_PAGA", "NOVA_OBRIGACAO", "BAIXA_DE_OBRIGACAO", "VINCULO_DE_DOCUMENTO", "SOLICITACAO_DE_REVISAO", "CONTA_RELATADA", "INTERCOMPANY"]);
export const requisitosParaOperacao = (unidade, tipo) => TIPOS_SEM_DEPENDENCIA_DE_FONTES.includes(tipo) || requisitosCompletos(unidade);

/** Mascara um JID de grupo/participante para log: só os 4 últimos dígitos. */
export function mascarar(jid) {
  const s = String(jid ?? "");
  const dig = s.split("@")[0].replace(/\D/g, "");
  return dig ? `…${dig.slice(-4)}@${s.split("@")[1] ?? "?"}` : null;
}
