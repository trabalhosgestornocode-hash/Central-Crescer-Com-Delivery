// MOVA CORE — validação ESTRITA dos argumentos de ferramenta (subconjunto de JSON Schema que o catálogo usa).
// O modelo nunca chama o núcleo com algo fora do esquema: campo desconhecido, tipo errado, enum fora da lista, texto longo
// ou padrão inválido ⇒ erro devolvido ao modelo (ARGUMENTO_INVALIDO), sem tocar em dado nenhum.
export class ErroDeArgumento extends Error {
  constructor(caminho, motivo) { super(`${caminho}: ${motivo}`); this.codigo = "ARGUMENTO_INVALIDO"; this.caminho = caminho; this.motivo = motivo; }
}

export function validarEsquema(esquema, valor, caminho = "entrada") {
  const tipo = esquema.type;
  if (valor === undefined || valor === null) {
    if (esquema.nullable || (Array.isArray(tipo) && tipo.includes("null"))) return valor ?? null;
    throw new ErroDeArgumento(caminho, "obrigatório");
  }
  const t = Array.isArray(tipo) ? tipo.filter((x) => x !== "null") : [tipo];
  if (t.includes("object")) {
    if (typeof valor !== "object" || Array.isArray(valor)) throw new ErroDeArgumento(caminho, "deve ser objeto");
    const props = esquema.properties ?? {};
    for (const k of Object.keys(valor)) if (!(k in props)) throw new ErroDeArgumento(`${caminho}.${k}`, "campo desconhecido");
    const saida = {};
    for (const [k, sub] of Object.entries(props)) {
      if (valor[k] === undefined) { if ((esquema.required ?? []).includes(k)) throw new ErroDeArgumento(`${caminho}.${k}`, "obrigatório"); continue; }
      saida[k] = validarEsquema(sub, valor[k], `${caminho}.${k}`);
    }
    return saida;
  }
  if (t.includes("array")) {
    if (!Array.isArray(valor)) throw new ErroDeArgumento(caminho, "deve ser lista");
    if (esquema.maxItems !== undefined && valor.length > esquema.maxItems) throw new ErroDeArgumento(caminho, `no máximo ${esquema.maxItems} itens`);
    return valor.map((v, i) => validarEsquema(esquema.items ?? {}, v, `${caminho}[${i}]`));
  }
  if (t.includes("string")) {
    if (typeof valor !== "string") throw new ErroDeArgumento(caminho, "deve ser texto");
    if (esquema.enum && !esquema.enum.includes(valor)) throw new ErroDeArgumento(caminho, `deve ser um de: ${esquema.enum.join(", ")}`);
    if (esquema.maxLength !== undefined && valor.length > esquema.maxLength) throw new ErroDeArgumento(caminho, `no máximo ${esquema.maxLength} caracteres`);
    if (esquema.pattern && !new RegExp(esquema.pattern).test(valor)) throw new ErroDeArgumento(caminho, "formato inválido");
    return valor;
  }
  if (t.includes("integer") || t.includes("number")) {
    if (typeof valor !== "number" || !Number.isFinite(valor) || (t.includes("integer") && !Number.isInteger(valor))) throw new ErroDeArgumento(caminho, "deve ser número inteiro");
    if (esquema.minimum !== undefined && valor < esquema.minimum) throw new ErroDeArgumento(caminho, `mínimo ${esquema.minimum}`);
    if (esquema.maximum !== undefined && valor > esquema.maximum) throw new ErroDeArgumento(caminho, `máximo ${esquema.maximum}`);
    return valor;
  }
  if (t.includes("boolean")) {
    if (typeof valor !== "boolean") throw new ErroDeArgumento(caminho, "deve ser verdadeiro/falso");
    return valor;
  }
  throw new ErroDeArgumento(caminho, "tipo não suportado");
}

// Blocos reutilizáveis
export const COMPETENCIA = { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$", description: "Mês no formato AAAA-MM." };
export const DATA = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Data no formato AAAA-MM-DD." };
export const REFERENCIA = { type: "string", pattern: "^ref_[a-z0-9]{1,12}$", description: "Referência opaca devolvida por outra ferramenta (ex.: ref_3)." };
export const TEXTO_CURTO = { type: "string", maxLength: 80 };
