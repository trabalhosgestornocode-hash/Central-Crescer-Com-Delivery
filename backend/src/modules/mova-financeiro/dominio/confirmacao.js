// MOVA — 24/11/2026: QUEM pode responder (confirmar) uma pergunta pendente do MOVA.
// Regra: só a MESMA PESSOA autorizada que enviou o documento da pergunta. Uma pessoa não confirma a operação de outra, nem por
// acidente (resposta citando a pergunta alheia, "sim" solto no grupo). A mesma pessoa pode aparecer com identificadores diferentes
// (LID no grupo × número na conversa privada; celular com/sem o nono dígito): vale a ENTRADA da lista de autorizados que a reconhece.
// Delegação formal de aprovação: o sistema ainda NÃO tem cadastro de delegação; quando existir, entra aqui (e só por ela).
import { conversaAutorizada, mesmoCelularBr } from "./configuracao.js";
import { participanteAutorizado } from "./participantes.js";

const ids = (entrada) => [...(entrada?.ids ?? []), ...(entrada?.privado ? [entrada.privado] : [])];

/**
 * @param {object} cfg configuração validada
 * @param {{participanteId:string, telefoneE164?:string|null, grupoId:string}} origem quem enviou o documento que gerou a pergunta
 * @param {{participanteId:string, telefoneE164?:string|null, grupoId:string}} quem quem está respondendo agora
 * @returns {{pode:boolean, motivo:string}}
 */
export function podeConfirmarPendencia(cfg, origem, quem) {
  if (!origem?.participanteId || !quem?.participanteId) return { pode: false, motivo: "SEM_PARTICIPANTE" };
  if (origem.participanteId === quem.participanteId) return { pode: true, motivo: "MESMO_PARTICIPANTE" };
  if (mesmoCelularBr(origem.participanteId, quem.participanteId)) return { pode: true, motivo: "MESMO_CELULAR" };
  if (origem.telefoneE164 && quem.telefoneE164 && origem.telefoneE164 === quem.telefoneE164) return { pode: true, motivo: "MESMO_TELEFONE" };
  // A ENTRADA da lista que autorizou o envio original (grupo de lista; grupo aberto não tem identidade além do JID).
  const grupoOrigem = conversaAutorizada(cfg, origem.grupoId);
  const entrada = grupoOrigem && (grupoOrigem.acesso ?? "ABERTO") === "LISTA" ? participanteAutorizado(grupoOrigem, origem) : null;
  if (entrada) {
    const conhecidos = ids(entrada);
    if (conhecidos.includes(quem.participanteId) || conhecidos.some((j) => mesmoCelularBr(j, quem.participanteId))) return { pode: true, motivo: "MESMA_PESSOA_AUTORIZADA" };
    if (quem.telefoneE164 && (entrada.telefones ?? []).includes(quem.telefoneE164)) return { pode: true, motivo: "MESMA_PESSOA_AUTORIZADA" };
  }
  return { pode: false, motivo: "OUTRO_PARTICIPANTE" };
}
