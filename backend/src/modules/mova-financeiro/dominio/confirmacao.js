// MOVA — 24/11/2026: QUEM pode responder (confirmar) uma pergunta pendente do MOVA, e se a pergunta ainda vale.
// Regra: a MESMA PESSOA autorizada que enviou o documento, ou (26/11) outro integrante do mesmo grupo de lista com perfil
// FINANCEIRO em todas as unidades que a operação alcança. Sem essa permissão, ninguém confirma a operação de outra pessoa.
// IDENTIDADE CANÔNICA (revisão 24/11): o identificador do WhatsApp entregue pelo gateway (JID), ou a MESMA ENTRADA da lista de
// autorizados da configuração do servidor (a entrada reúne os JIDs daquela pessoa: LID no grupo × número no privado). Coincidência
// de TELEFONE (telefoneE164) ou de celular SOZINHA não basta — só vale quando a própria entrada lista aquele identificador.
// Quem responde também precisa estar AUTORIZADO na conversa em que responde e essa conversa precisa alcançar a UNIDADE da pendência.
// Delegação formal de aprovação: o sistema ainda NÃO tem cadastro de delegação; quando existir, entra aqui (e só por ela).
import { conversaAutorizada, mesmoCelularBr } from "./configuracao.js";
import { PERFIL, participanteAutorizado, perfilNa } from "./participantes.js";

// 25/11 — COMPLEMENTO de informação (não é confirmação de efeito financeiro): competência, descrição, unidade. Outro participante
// FINANCEIRO autorizado NA UNIDADE da pendência, no MESMO grupo e citando a pergunta, pode completar. As perguntas que decidem o
// EFEITO (é o mesmo pagamento? é juros? é parcial? qual conta?) continuam só com quem enviou o documento.
export const TIPOS_COMPLEMENTO = Object.freeze(["COMPETENCIA", "DESCRICAO", "UNIDADE"]);

const idsDa = (entrada) => [...(entrada?.ids ?? []), ...(entrada?.privado ? [entrada.privado] : [])];
// reconhecimento por IDENTIFICADOR: o JID listado na entrada, ou o mesmo celular brasileiro com/sem o nono dígito DE UM JID LISTADO
// (o WhatsApp entrega as duas formas). Nunca pelo telefoneE164 informado no evento, nem por nome.
// 25/11: o telefone entregue pelo GATEWAY (canal HMAC, `participantPn` do próprio WhatsApp para o LID do grupo) é a MESMA regra
// que autorizou a mensagem na recepção — sem ele, quem aparece no grupo pelo LID (…@lid) não era reconhecido ao responder e
// recebia "documento enviado por outra pessoa" mesmo sendo quem enviou. Nunca por nome.
const porIdentificador = (conversa, participanteId, telefoneE164 = null) => {
  if (!conversa) return null;
  const direto = participanteAutorizado(conversa, { participanteId, telefoneE164 });
  if (direto && !direto.aberto) return direto;
  const pelaLista = (conversa.participantes ?? []).find((p) => idsDa(p).some((j) => mesmoCelularBr(j, participanteId))) ?? null;
  return pelaLista ?? direto;
};

/**
 * @param {object} cfg configuração validada
 * @param {{participanteId:string, grupoId:string}} origem quem enviou o documento que gerou a pergunta
 * @param {{participanteId:string, grupoId:string}} quem quem está respondendo agora
 * @param {{unidadeId?:string|null, tipo?:string|null}} [pendencia] unidade e tipo da pergunta pendente (null = pergunta de unidade)
 * @returns {{pode:boolean, motivo:string}}
 */
export function podeConfirmarPendencia(cfg, origem, quem, { unidadeId = null, tipo = null, unidadesExigidas = null } = {}) {
  if (!origem?.participanteId || !quem?.participanteId) return { pode: false, motivo: "SEM_PARTICIPANTE" };
  // quem responde precisa ser reconhecido na conversa em que responde, e ela alcançar a unidade
  const conversaDeQuem = conversaAutorizada(cfg, quem.grupoId);
  const entradaDeQuem = porIdentificador(conversaDeQuem, quem.participanteId, quem.telefoneE164 ?? null);
  if (!entradaDeQuem) return { pode: false, motivo: "NAO_AUTORIZADO_NESTA_CONVERSA" };
  if (unidadeId && !(entradaDeQuem.unidades ?? conversaDeQuem.unidades ?? []).includes(unidadeId)) return { pode: false, motivo: "UNIDADE_FORA_DA_CONVERSA" };
  if (origem.participanteId === quem.participanteId) return { pode: true, motivo: "MESMO_IDENTIFICADOR" };
  if (mesmoCelularBr(origem.participanteId, quem.participanteId)) return { pode: true, motivo: "MESMO_CELULAR" }; // mesmo JID de celular com/sem 9 (quem responde já foi reconhecido pela lista)
  // a ENTRADA da lista que autorizou o envio original (grupo de lista; grupo aberto não tem identidade além do JID)
  const conversaDeOrigem = conversaAutorizada(cfg, origem.grupoId);
  const entrada = conversaDeOrigem && (conversaDeOrigem.acesso ?? "ABERTO") === "LISTA" ? porIdentificador(conversaDeOrigem, origem.participanteId, origem.telefoneE164 ?? null) : null;
  if (entrada) {
    if (entrada === entradaDeQuem) return { pode: true, motivo: "MESMA_PESSOA_AUTORIZADA" };
    const conhecidos = idsDa(entrada);
    if (conhecidos.includes(quem.participanteId) || conhecidos.some((j) => mesmoCelularBr(j, quem.participanteId))) return { pode: true, motivo: "MESMA_PESSOA_AUTORIZADA" };
  }
  // 26/11 — COLABORAÇÃO POR PERMISSÃO: outro integrante do MESMO grupo de LISTA (nunca a conversa privada de outra pessoa) responde
  // QUALQUER pergunta (complemento ou confirmação de efeito) quando tem perfil FINANCEIRO em TODAS as unidades que a operação
  // alcança — uma unidade comum; as DUAS no intercompany (`unidadesExigidas`). Pergunta de unidade ainda sem unidade: FINANCEIRO em
  // todas as unidades da conversa (assim a escolha nunca leva a operação para onde a pessoa não tem permissão). Quem confirma fica
  // na decisão (participanteId), auditado individualmente. A escrita continua conferida pela concessão no Financeiro.
  const mesmoGrupo = quem.grupoId === origem.grupoId && String(quem.grupoId).endsWith("@g.us") && (conversaDeQuem?.acesso ?? "ABERTO") === "LISTA" && !entradaDeQuem.aberto;
  const exigidas = [...new Set([...(unidadesExigidas ?? []), ...(unidadeId ? [unidadeId] : [])])];
  const alvo = exigidas.length ? exigidas : (conversaDeQuem?.unidades ?? []);
  // a unidade precisa estar no alcance DA PESSOA (entrada.unidades, quando restrita) — não basta o perfil genérico da entrada
  const alcance = entradaDeQuem.unidades ?? conversaDeQuem?.unidades ?? [];
  if (mesmoGrupo && alvo.length && alvo.every((u) => alcance.includes(u) && perfilNa(entradaDeQuem, u) === PERFIL.FINANCEIRO)) {
    return { pode: true, motivo: TIPOS_COMPLEMENTO.includes(tipo ?? "UNIDADE") ? "COMPLEMENTO_DE_FINANCEIRO_AUTORIZADO" : "CONFIRMACAO_DE_FINANCEIRO_AUTORIZADO" };
  }
  return { pode: false, motivo: mesmoGrupo ? "SEM_PERMISSAO_FINANCEIRA_NA_UNIDADE" : "OUTRO_PARTICIPANTE" };
}

/**
 * VERSÃO de uma conta candidata: o que, se mudar entre a pergunta e a resposta, torna a resposta inválida — não só o saldo:
 * valor original, saldo, pago, fornecedor/beneficiário, categoria, competência, vencimento, situação e unidade.
 */
export function versaoDaConta(t, unidadeId = null) {
  if (!t) return null;
  return [
    t.saldoCentavos ?? null, t.valorOriginalCentavos ?? t.valorCentavos ?? null, t.pagoCentavos ?? null, t.fornecedor?.id ?? t.contraparteId ?? null,
    t.categoria?.codigo ?? t.categoria ?? null, t.competencia ?? null, t.vencimento ?? null, t.situacao ?? null, unidadeId,
  ].map((x) => (x === null || x === undefined ? "" : String(x))).join("|");
}

/** O que mudou entre duas versões (para a resposta dizer por que a pergunta ficou desatualizada). */
export function camposAlterados(antes, agora) {
  const nomes = ["saldo", "valor", "valor pago", "fornecedor", "categoria", "competência", "vencimento", "situação", "unidade"];
  const a = String(antes ?? "").split("|"); const b = String(agora ?? "").split("|");
  return nomes.filter((_, i) => a[i] !== b[i]);
}
