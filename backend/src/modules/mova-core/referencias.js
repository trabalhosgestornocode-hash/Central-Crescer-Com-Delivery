// MOVA CORE — REFERÊNCIAS OPACAS. O modelo nunca vê um identificador interno (UUID de conta, fornecedor, entregador…):
// cada resultado de ferramenta troca os UUIDs por `ref_N`, válidos SÓ nesta conversa e para a mesma unidade em que nasceram.
// Ao receber `ref_N` de volta, o executor resolve para o UUID original; referência desconhecida ou de outra unidade é recusada.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^ref_[a-z0-9]{1,12}$/;

export class ErroDeReferencia extends Error {
  constructor(ref) { super(`referência desconhecida: ${ref}`); this.codigo = "REFERENCIA_INVALIDA"; }
}

export function criarReferencias() {
  const porUuid = new Map(); // uuid → ref
  const porRef = new Map(); // ref → { uuid, unidadeId }
  let n = 0;
  function opacar(valor, unidadeId) {
    if (typeof valor === "string" && UUID.test(valor)) {
      const chave = `${unidadeId}|${valor.toLowerCase()}`;
      if (!porUuid.has(chave)) { const ref = `ref_${(++n).toString(36)}`; porUuid.set(chave, ref); porRef.set(ref, { uuid: valor, unidadeId }); }
      return porUuid.get(chave);
    }
    if (Array.isArray(valor)) return valor.map((v) => opacar(v, unidadeId));
    if (valor && typeof valor === "object") return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, opacar(v, unidadeId)]));
    return valor;
  }
  function resolver(valor, unidadeId) {
    if (typeof valor === "string" && REF.test(valor)) {
      const r = porRef.get(valor);
      if (!r || r.unidadeId !== unidadeId) throw new ErroDeReferencia(valor); // ref de outra unidade NUNCA atravessa
      return r.uuid;
    }
    if (typeof valor === "string" && UUID.test(valor)) throw new ErroDeReferencia("identificador interno não é aceito; use a referência"); // o modelo não injeta UUID
    if (Array.isArray(valor)) return valor.map((v) => resolver(v, unidadeId));
    if (valor && typeof valor === "object") return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, resolver(v, unidadeId)]));
    return valor;
  }
  return Object.freeze({ opacar, resolver, total: () => porRef.size });
}
