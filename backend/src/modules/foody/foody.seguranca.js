// Segurança da camada central Foody: cifra do token por unidade, impressão do token, HMAC do nome do entregador e log seguro.
//
// REGRAS:
//   * o token Foody tem poder de ESCRITA na conta — nunca aparece em log, erro, banco (em claro) ou relatório;
//   * o token é cifrado com AES-256-GCM e AAD = "foody:token:<unidade_id>": cifrado para uma unidade, não decifra em outra;
//   * o nome do entregador nunca é gravado: só HMAC-SHA256 (chave fora do banco), truncado a 16 hex;
//   * todo log do módulo passa por foodyLog(), que remove chaves sensíveis e qualquer ocorrência dos segredos conhecidos.
import crypto from "node:crypto";
import { criarCifraAutenticada } from "../../shared/cripto.js";
import { sanitizar } from "../ifood/ifood.logsafe.js";
import { ENV_SEGREDO } from "./foody.constants.js";

const MASCARA = "[REDACTED]";

export class FoodyConfigErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodyConfigErro"; this.codigo = codigo; }
}

function derivar(segredo, info) {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(segredo, "utf8"), Buffer.from("crescer-foody-v1"), Buffer.from(info), 32));
}

/**
 * Cria as primitivas a partir do segredo (env FOODY_CENTRAL_SECRET). Sem segredo forte, falha FECHADO.
 * @param {string} [segredo]
 */
export function criarSegurancaFoody(segredo = process.env[ENV_SEGREDO]) {
  if (typeof segredo !== "string" || segredo.trim().length < 32) {
    throw new FoodyConfigErro("SEGREDO_AUSENTE", `${ENV_SEGREDO} ausente ou curto (mínimo 32 caracteres).`);
  }
  const cifra = criarCifraAutenticada(derivar(segredo, "token"), { versao: 1 });
  const chaveHmac = derivar(segredo, "entregador");
  const aad = (unidadeId) => {
    if (!unidadeId) throw new FoodyConfigErro("UNIDADE_AUSENTE", "unidade obrigatória para cifrar/decifrar o token.");
    return `foody:token:${String(unidadeId).toLowerCase()}`;
  };
  return {
    cifrarToken: (token, unidadeId) => cifra.cifrar(String(token ?? "").trim(), aad(unidadeId)),
    decifrarToken: (cifrado, unidadeId) => cifra.decifrar(cifrado, aad(unidadeId)),
    hashEntregador: (nome) => {
      const n = normalizarNome(nome);
      return n ? crypto.createHmac("sha256", chaveHmac).update(n).digest("hex").slice(0, 16) : null;
    },
  };
}

/** Impressão do token: prefixo de SHA-256 (12 hex) — compara "é o mesmo token?" sem revelá-lo. */
export function impressaoToken(token) {
  return crypto.createHash("sha256").update(String(token ?? "").trim()).digest("hex").slice(0, 12);
}

/** Mesma normalização de chave do Parser (chaveEntregador): caixa, acento e espaços — nunca aproxima nomes diferentes. */
export function normalizarNome(nome) {
  return String(nome ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/** Remove de um texto qualquer ocorrência literal dos segredos informados. */
export function redigir(texto, segredos = []) {
  let s = String(texto ?? "");
  for (const seg of segredos) if (typeof seg === "string" && seg.length >= 6) s = s.split(seg).join(MASCARA);
  return s;
}

function redigirProfundo(valor, segredos, prof = 0) {
  if (prof > 6) return "[...]";
  if (typeof valor === "string") return redigir(valor, segredos);
  if (Array.isArray(valor)) return valor.map((v) => redigirProfundo(v, segredos, prof + 1));
  if (valor && typeof valor === "object") return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, redigirProfundo(v, segredos, prof + 1)]));
  return valor;
}

/**
 * Log seguro do módulo. `segredos` = valores a redigir literalmente (ex.: o token em uso).
 * @param {(linha:string)=>void} [saida] injetável nos testes
 */
export function foodyLog(nivel, evento, dados = {}, { segredos = [], saida } = {}) {
  const linha = JSON.stringify({ modulo: "foody", nivel, evento, ...redigirProfundo(sanitizar(dados), segredos) });
  (saida ?? ((l) => (nivel === "error" ? console.error(l) : console.log(l))))(linha);
  return linha;
}
