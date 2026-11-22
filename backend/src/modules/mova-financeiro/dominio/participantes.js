// PARTICIPANTES, ACIONAMENTO e CONFIDENCIALIDADE nos grupos reais (Agente 2 — Frente A).
//
// Regras (todas fail-closed):
//   - Grupo com acesso "LISTA": só fala com o MOVA quem está na lista do grupo (cadastro feito por um administrador, nunca
//     automático). Desconhecido: a mensagem é descartada ANTES de ser guardada (nada de texto ou documento de terceiro no banco).
//   - O MOVA só responde quando é CHAMADO: o nome "MOVA" no texto/legenda, resposta (citação) a uma mensagem do MOVA, resposta a
//     uma pergunta pendente, ou continuidade da conversa do MESMO participante logo depois de uma resposta do MOVA a ele.
//   - Perfil do participante: o que ele pode pedir. As unidades dele são um SUBCONJUNTO das unidades do grupo.
//   - Confidencialidade: no grupo saem só respostas sem valores (contagens, orientação, recebimento de documento). Consulta com
//     valores vai para a conversa PRIVADA do participante; no grupo fica só o aviso. Sem conversa privada cadastrada: o MOVA não
//     mostra o valor no grupo e diz como resolver.
//   - Nome exibido no WhatsApp nunca identifica ninguém: a identidade é o JID (ou o telefone verificado entregue pelo Gateway).

export const ACESSO = Object.freeze({ ABERTO: "ABERTO", LISTA: "LISTA" });
export const PERFIL = Object.freeze({ FINANCEIRO: "FINANCEIRO", CONSULTA: "CONSULTA", OPERACIONAL: "OPERACIONAL" });
/** O que cada perfil pode fazer pelo WhatsApp. Aprovar/aplicar continua SÓ no Centro Financeiro (Nível 2), para todos. */
export const CAPACIDADES = Object.freeze({
  FINANCEIRO: Object.freeze({ consultas: "TODAS", documentos: true }),
  CONSULTA: Object.freeze({ consultas: "TODAS", documentos: false }),
  OPERACIONAL: Object.freeze({ consultas: "SEM_VALORES", documentos: true }),
});
/** Consultas sem valores financeiros (contagens): podem ser respondidas no próprio grupo. */
export const CONSULTAS_SEM_VALORES = Object.freeze(["SITUACAO_PROPOSTAS", "PENDENCIAS", "CATEGORIAS", "DOCUMENTOS"]);
/** Janela de continuidade: depois de responder ao participante, o MOVA escuta a PRÓXIMA mensagem dele sem exigir o nome. */
export const JANELA_CONTINUIDADE_MS = 10 * 60 * 1000; // a mesma validade da memória curta (MEMORIA_CURTA_MS)

const JID_PRIVADO = /^[1-9][0-9]{7,14}@s\.whatsapp\.net$/;
const JID_PARTICIPANTE = /^[A-Za-z0-9_.:@-]{1,160}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const CHAMADO = /(^|[^\p{L}\p{N}])@?mova([^\p{L}\p{N}]|$)/iu;

/** O texto chama o MOVA pelo nome (palavra inteira, com ou sem @, sem acento/caixa)? */
export const chamaPeloNome = (texto) => CHAMADO.test(String(texto ?? "").normalize("NFD").replace(/\p{M}/gu, ""));

/** Valida e normaliza a lista de participantes de um grupo (lança com o CAMPO, nunca com o valor). */
export function validarParticipantes(lista, { unidadesDoGrupo, campo, exigir }) {
  exigir(Array.isArray(lista), `${campo}.participantes`);
  const vistos = new Set();
  return Object.freeze(lista.map((p, j) => {
    const c = `${campo}.participantes[${j}]`;
    exigir(p && typeof p === "object", c);
    const ids = (Array.isArray(p.ids) ? p.ids : []).map(String);
    const telefones = (Array.isArray(p.telefones) ? p.telefones : []).map(String);
    exigir(ids.length + telefones.length > 0, `${c}.identificacao`);
    exigir(ids.every((x) => JID_PARTICIPANTE.test(x)) && telefones.every((x) => E164.test(x)), `${c}.identificacao`);
    for (const k of [...ids, ...telefones]) { exigir(!vistos.has(k), `${c}.duplicado`); vistos.add(k); }
    exigir(Object.values(PERFIL).includes(p.perfil), `${c}.perfil`);
    const unidades = (Array.isArray(p.unidades) && p.unidades.length ? p.unidades : unidadesDoGrupo).map((x) => String(x).toLowerCase());
    exigir(unidades.every((u) => unidadesDoGrupo.includes(u)), `${c}.unidades`);
    exigir(p.privado == null || JID_PRIVADO.test(p.privado), `${c}.privado`);
    exigir(p.nome == null || (typeof p.nome === "string" && p.nome.length <= 60), `${c}.nome`);
    return Object.freeze({
      ids: Object.freeze(ids), telefones: Object.freeze(telefones), perfil: p.perfil, unidades: Object.freeze([...new Set(unidades)]),
      privado: p.privado ?? null, nome: p.nome ?? null,
    });
  }));
}

/** Participante AUTORIZADO do grupo, pelo JID ou pelo telefone verificado. Grupo ABERTO (legado) ⇒ perfil FINANCEIRO, todas as unidades. */
export function participanteAutorizado(grupo, { participanteId, telefoneE164 = null }) {
  if (!grupo || !participanteId) return null;
  if ((grupo.acesso ?? ACESSO.ABERTO) === ACESSO.ABERTO) return { perfil: PERFIL.FINANCEIRO, unidades: grupo.unidades, privado: null, nome: null, aberto: true };
  return grupo.participantes.find((p) => p.ids.includes(participanteId) || (telefoneE164 && p.telefones.includes(telefoneE164))) ?? null;
}

/** Destino privado do participante: o cadastrado; senão o próprio JID, se for de telefone. Nunca um JID de grupo. */
export function destinoPrivado(participante, participanteId) {
  if (participante?.privado) return participante.privado;
  return JID_PRIVADO.test(String(participanteId ?? "")) ? participanteId : null;
}

/** A consulta pode ser pedida por este perfil? */
export function perfilPodeConsultar(perfil, consulta) {
  const c = CAPACIDADES[perfil];
  return Boolean(c) && (c.consultas === "TODAS" || CONSULTAS_SEM_VALORES.includes(consulta));
}

/** A resposta desta consulta pode sair NO GRUPO? (o grupo pode liberar mais consultas, explicitamente) */
export function consultaPodeSairNoGrupo(grupo, consulta) {
  return CONSULTAS_SEM_VALORES.includes(consulta);
}

/**
 * Agente 2 — POLÍTICA DE RESPOSTA do grupo (padrão PRIVADO_RESTRITO):
 *   PRIVADO_RESTRITO  valores só no privado autorizado (no grupo, o aviso sem valores);
 *   GRUPO_FINANCEIRO  valores no próprio grupo SÓ quando o retrato dos membros atuais é recente e TODOS estão autorizados a
 *                     ver aquela consulta naquelas unidades; qualquer dúvida ⇒ volta para o privado (nunca expõe);
 *   OPERACIONAL       grupo de rotina: só informações operacionais (contagens, documentos); consulta com valores não é atendida.
 */
export const POLITICA_RESPOSTA = Object.freeze({ PRIVADO_RESTRITO: "PRIVADO_RESTRITO", GRUPO_FINANCEIRO: "GRUPO_FINANCEIRO", OPERACIONAL: "OPERACIONAL" });
/** Retrato dos membros mais velho que isto não comprova nada (o grupo pode ter ganhado um membro). */
export const RETRATO_VALIDADE_MS = 15 * 60 * 1000;
const telefoneDoJid = (jid) => (/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(jid ?? "") ? `+${jid.split("@")[0]}` : null);

/**
 * Para onde vai a resposta de uma consulta pedida NUM GRUPO por LISTA.
 * @param {{grupo:object, consulta:string, unidades:string[], retrato:{membros:string[], verificadoEm:string|Date}|null, agora:Date}} p
 * @returns {{saida:"GRUPO"|"PRIVADO"|"RECUSAR", motivo:string}}
 */
export function decidirSaidaNoGrupo({ grupo, consulta, unidades, retrato, agora }) {
  if (CONSULTAS_SEM_VALORES.includes(consulta)) return { saida: "GRUPO", motivo: "SEM_VALORES" };
  const politica = grupo.politicaResposta ?? POLITICA_RESPOSTA.PRIVADO_RESTRITO;
  if (politica === POLITICA_RESPOSTA.OPERACIONAL) return { saida: "RECUSAR", motivo: "GRUPO_OPERACIONAL" };
  if (politica !== POLITICA_RESPOSTA.GRUPO_FINANCEIRO) return { saida: "PRIVADO", motivo: "PRIVADO_RESTRITO" };
  if ((grupo.consultasNoGrupo ?? []).length && !grupo.consultasNoGrupo.includes(consulta)) return { saida: "PRIVADO", motivo: "CONSULTA_FORA_DO_GRUPO" };
  if (!retrato || !Array.isArray(retrato.membros) || !retrato.membros.length || !retrato.verificadoEm) return { saida: "PRIVADO", motivo: "MEMBROS_NAO_COMPROVADOS" };
  const idade = agora.getTime() - new Date(retrato.verificadoEm).getTime();
  if (!(idade >= 0 && idade <= RETRATO_VALIDADE_MS)) return { saida: "PRIVADO", motivo: "RETRATO_DESATUALIZADO" };
  for (const m of retrato.membros) {
    const p = participanteAutorizado(grupo, { participanteId: m, telefoneE164: telefoneDoJid(m) });
    if (!p || !unidades.every((u) => p.unidades.includes(u) && perfilPodeConsultar(perfilNa(p, u), consulta))) return { saida: "PRIVADO", motivo: "MEMBRO_SEM_AUTORIZACAO" };
  }
  return { saida: "GRUPO", motivo: "TODOS_OS_MEMBROS_AUTORIZADOS" };
}

/** Perfil do participante NA unidade (na conversa privada derivada, cada unidade guarda o perfil do grupo de origem). */
export const perfilNa = (participante, unidadeId) => participante?.perfilPorUnidade?.[unidadeId] ?? participante?.perfil ?? null;
/** Alguma das unidades do participante permite esta capacidade? (antes de a unidade estar resolvida) */
export const algumaUnidadePermite = (participante, teste) => (participante?.unidades ?? []).some((u) => teste(CAPACIDADES[perfilNa(participante, u)] ?? {}));

/**
 * Conversas privadas DERIVADAS (modo OPERACAO): uma por pessoa com destino privado, com as unidades que ela tem nos grupos e o
 * perfil de CADA unidade (estar em dois grupos não soma poder: na mesma unidade com dois perfis, fica o menos amplo).
 */
export function conversasPrivadasDerivadas(grupos) {
  const ORDEM = [PERFIL.OPERACIONAL, PERFIL.CONSULTA, PERFIL.FINANCEIRO];
  const menosAmplo = (a, b) => {
    if (!a) return b;
    if (a === b) return a;
    // CONSULTA × OPERACIONAL não têm capacidade comum com valores: fica OPERACIONAL (sem valores).
    return ORDEM[Math.min(ORDEM.indexOf(a), ORDEM.indexOf(b))];
  };
  const porJid = new Map();
  for (const g of grupos) {
    if (!g.grupoId.endsWith("@g.us") || g.acesso !== ACESSO.LISTA) continue;
    for (const p of g.participantes) {
      const jid = destinoPrivado(p, p.ids.find((x) => JID_PRIVADO.test(x)) ?? null);
      if (!jid) continue;
      const atual = porJid.get(jid) ?? { ids: new Set(), telefones: new Set(), perfilPorUnidade: {}, nome: null };
      for (const x of [...p.ids, jid]) atual.ids.add(x);
      for (const x of p.telefones) atual.telefones.add(x);
      for (const u of p.unidades) atual.perfilPorUnidade[u] = menosAmplo(atual.perfilPorUnidade[u], p.perfil);
      atual.nome ??= p.nome;
      porJid.set(jid, atual);
    }
  }
  return [...porJid.entries()].map(([jid, a]) => {
    const unidades = Object.freeze(Object.keys(a.perfilPorUnidade));
    const participante = Object.freeze({ ids: Object.freeze([...a.ids]), telefones: Object.freeze([...a.telefones]), perfil: null, perfilPorUnidade: Object.freeze({ ...a.perfilPorUnidade }), unidades, privado: jid, nome: a.nome });
    return Object.freeze({ grupoId: jid, unidades, acesso: ACESSO.LISTA, privada: true, derivada: true, consultasNoGrupo: Object.freeze([]), participantes: Object.freeze([participante]) });
  });
}

/**
 * O MOVA foi CHAMADO por esta mensagem? Grupo com LISTA: nome "MOVA", citação de uma resposta do MOVA ou continuidade da
 * conversa do MESMO participante. Conversa privada (derivada/homologação/piloto): sempre. Grupo ABERTO (legado): sempre.
 */
export async function foiAcionado({ grupo, bruto, armazenamento }) {
  if (!grupo.grupoId.endsWith("@g.us") || (grupo.acesso ?? ACESSO.ABERTO) !== ACESSO.LISTA) return { acionado: true, por: "CONVERSA" };
  if (chamaPeloNome(bruto.texto)) return { acionado: true, por: "NOME" };
  if (bruto.respostaA && await armazenamento.saida.ehRespostaPropria(bruto.respostaA)) return { acionado: true, por: "CITACAO" };
  if (typeof armazenamento.conversas?.obter === "function" && await armazenamento.conversas.obter({ grupoId: grupo.grupoId, participanteId: bruto.participanteId })) return { acionado: true, por: "CONTINUIDADE" };
  return { acionado: false, por: null };
}
