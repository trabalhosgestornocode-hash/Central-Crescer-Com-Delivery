// MOVA CORE — F1: CONTINUIDADE MÍNIMA da conversa (a memória completa é a F2).
// Por conversa (conversa × participante): os últimos turnos (pergunta e resposta, texto), as referências opacas já emitidas
// (para "e ele?" apontar a mesma entidade), as entidades citadas recentemente e um cache curto das leituras.
// Expira com a mesma janela de continuidade do MOVA (10 min sem falar = conversa nova). Nunca guarda dado entre unidades:
// a chave inclui a organização, e as referências já são presas à unidade em que nasceram.
import { criarReferencias } from "./referencias.js";

export const JANELA_MS = 10 * 60 * 1000;
export const MAX_TURNOS = 6;

export function criarMemoriaDeConversas({ relogio = () => Date.now(), janelaMs = JANELA_MS, maxConversas = 2000 } = {}) {
  const conversas = new Map();
  function obter({ organizacaoId, conversaId, participanteId }) {
    const chave = `${organizacaoId}|${conversaId}|${participanteId}`;
    const agora = relogio();
    let c = conversas.get(chave);
    if (c && agora - c.ultimaEm > janelaMs) { conversas.delete(chave); c = null; }
    if (!c) {
      if (conversas.size >= maxConversas) conversas.delete(conversas.keys().next().value); // a mais antiga
      c = { chave, turnos: [], entidades: [], fatos: [], referencias: criarReferencias(), cache: new Map(), ultimaEm: agora };
      conversas.set(chave, c);
    }
    return c;
  }
  function registrarTurno(c, { pergunta, resposta, ferramentas = [], fatos = [] }) {
    c.ultimaEm = relogio();
    c.turnos.push({ pergunta: String(pergunta).slice(0, 600), resposta: String(resposta ?? "").slice(0, 1200), ferramentas });
    while (c.turnos.length > MAX_TURNOS) c.turnos.shift();
    const novas = [...new Set(fatos.map((f) => f.entidade).filter((e) => typeof e === "string" && e.length >= 3))].slice(0, 8);
    c.entidades = [...new Set([...novas, ...c.entidades])].slice(0, 12);
    // fatos dos turnos anteriores (para "compara isso com o mês passado" e para o verificador aceitar o que JÁ foi consultado)
    c.fatos = [...c.fatos, ...fatos.filter((f) => !f.anterior).map((f) => ({ ...f, anterior: true }))].slice(-300);
  }
  /** Turnos anteriores como mensagens da API (só texto: os blocos de ferramenta não são reenviados). */
  function historico(c) {
    return c.turnos.flatMap((t) => [{ role: "user", content: t.pergunta }, { role: "assistant", content: t.resposta || "(sem resposta)" }]);
  }
  return Object.freeze({ obter, registrarTurno, historico, tamanho: () => conversas.size });
}
