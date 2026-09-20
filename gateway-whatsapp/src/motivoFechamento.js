// Motivo ESTRUTURAL de um fechamento do socket (Checkpoint C.9.1, item 15 — o `stream:error` que
// derruba o Gateway com badSession/500 a cada ~50 min sem que o log diga POR QUÊ).
//
// No Baileys 6.7.24 (Socket/socket.js) só há dois caminhos que viram Boom com status 500 a partir do
// servidor, e a MENSAGEM da Boom os distingue:
//   ws.on('CB:stream:error') -> end(new Boom(`Stream Errored (${reason})`, {statusCode, data: node}))
//        reason = tag do 1º filho do <stream:error> (ou 'unknown'); statusCode = attrs.code || (conflict -> 440) || 500
//   ws.on('CB:failure')      -> end(new Boom('Connection Failure', {statusCode: attrs.reason || 500, data: attrs}))
// Sem este campo os dois aparecem iguais no log ("badSession"). Aqui só sai vocabulário FECHADO:
// a tag do protocolo (slug curto), o NOME dos atributos (nunca os valores) e, se numéricos, os códigos.
// Nunca `data.content`, nunca valores de atributo não numéricos, nunca a mensagem inteira do erro.

const SLUG = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
const slugOu = (v) => (typeof v === "string" && SLUG.test(v) ? v : null);
const numeroOu = (v) => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 9999 ? n : null;
};

/** @returns {{origemFechamento?: string, motivoStream?: string|null, atributosStream?: string[], codigoAtributoStream?: number|null}} */
export function motivoFechamento(error) {
  try {
    const msg = typeof error?.message === "string" ? error.message : "";
    const stream = /^Stream Errored \(([^)]*)\)$/.exec(msg);
    if (stream) {
      const attrs = error?.data?.attrs && typeof error.data.attrs === "object" ? error.data.attrs : {};
      return {
        origemFechamento: "stream_error",
        motivoStream: stream[1] === "restart required" ? "restart_required" : slugOu(stream[1]),
        atributosStream: Object.keys(attrs).filter((k) => slugOu(k)).slice(0, 8),
        codigoAtributoStream: numeroOu(attrs.code),
      };
    }
    if (msg === "Connection Failure") {
      return { origemFechamento: "failure", codigoAtributoStream: numeroOu(error?.data?.reason) };
    }
    return {};
  } catch {
    return {};
  }
}
