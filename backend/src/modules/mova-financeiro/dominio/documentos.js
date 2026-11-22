// MOVA — Agente 2: IDENTIDADE do documento entre formatos (PDF × foto × print × encaminhado).
//
// O sha256 só reconhece o MESMO arquivo. O mesmo boleto chega como PDF (linha digitável) e como foto (código de barras); a
// mesma NF-e/NFS-e chega em PDF e em imagem. A chave canônica junta essas formas para que um documento nunca gere duas
// propostas. O texto lido é dado NÃO confiável: a chave só existe quando os dígitos têm o formato e os dígitos verificadores
// certos — senão é null (e vale só o sha256), nunca um palpite.

const dv10 = (s) => { let soma = 0, peso = 2; for (let i = s.length - 1; i >= 0; i--) { let p = Number(s[i]) * peso; if (p > 9) p = Math.floor(p / 10) + (p % 10); soma += p; peso = peso === 2 ? 1 : 2; } return (10 - (soma % 10)) % 10; };
const dv11Boleto = (s) => { let soma = 0, peso = 2; for (let i = s.length - 1; i >= 0; i--) { soma += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; } const r = 11 - (soma % 11); return r === 0 || r === 10 || r === 11 ? 1 : r; };
const dv11Chave = (s) => { let soma = 0, peso = 2; for (let i = s.length - 1; i >= 0; i--) { soma += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; } const r = soma % 11; return r < 2 ? 0 : 11 - r; };

/** Boleto BANCÁRIO: linha digitável (47) → código de barras (44), conferindo os DVs dos campos e o DV geral. */
function barrasDoBancario(l) {
  const campos = [[l.slice(0, 9), l[9]], [l.slice(10, 20), l[20]], [l.slice(21, 31), l[31]]];
  if (!campos.every(([c, d]) => dv10(c) === Number(d))) return null;
  const barras = l.slice(0, 4) + l[32] + l.slice(33, 47) + l.slice(4, 9) + l.slice(10, 20) + l.slice(21, 31);
  return barrasValidas(barras) ? barras : null;
}
/** Código de barras bancário (44): DV geral na posição 5 (módulo 11). Arrecadação (começa com 8): aceito pelo formato. */
function barrasValidas(b) {
  if (!/^\d{44}$/.test(b)) return false;
  if (b[0] === "8") return true;
  return dv11Boleto(b.slice(0, 4) + b.slice(5)) === Number(b[4]);
}
/** Arrecadação/convênio: linha (48, 4 blocos de 11 + DV) → barras (44). */
function barrasDaArrecadacao(l) {
  const blocos = [0, 1, 2, 3].map((i) => l.slice(i * 12, i * 12 + 11));
  const mod10 = ["6", "7"].includes(l[2]);
  if (mod10 && !blocos.every((b, i) => dv10(b) === Number(l[i * 12 + 11]))) return null;
  return blocos.join("");
}

/**
 * Chave canônica do documento ou null. BOLETO: código de barras (44). NOTA_FISCAL: chave de acesso (44, DV módulo 11).
 * Comprovante de PIX/TED usa o identificador da transação (Frente B), não esta chave.
 */
export function chaveDoDocumento({ tipoDocumento, identificadorDocumento } = {}) {
  const d = String(identificadorDocumento ?? "").replace(/\D/g, "");
  if (tipoDocumento === "BOLETO") {
    let barras = null;
    if (d.length === 44) barras = barrasValidas(d) ? d : null;
    else if (d.length === 47) barras = barrasDoBancario(d);
    else if (d.length === 48 && d[0] === "8") barras = barrasDaArrecadacao(d);
    return barras ? `BOLETO:${barras}` : null;
  }
  if (tipoDocumento === "NOTA_FISCAL" && d.length === 44 && dv11Chave(d.slice(0, 43)) === Number(d[43])) return `NOTA_FISCAL:${d}`;
  return null;
}

/**
 * Agente 2 — documento recebido SEM leitura, como a Central o mostra. Estado = a ÚLTIMA conferência humana (trilha só de inclusão);
 * versão = quantas conferências já houve (concorrência otimista). Nenhum campo vem do conteúdo do arquivo.
 */
export function linhaDoRecebido(sha256, d, conferencias = [], { removida = false } = {}) {
  const l = d.leitura ?? {};
  const ultima = conferencias.at(-1) ?? null;
  const conf = (x) => ({ estado: x.estado, tipo: x.tipo ?? null, obrigacaoId: x.obrigacaoId ?? null, observacao: x.observacao ?? null, por: x.por ?? null, em: x.em instanceof Date ? x.em.toISOString() : x.em ?? null });
  return Object.freeze({
    sha256, protocolo: /^[0-9a-f]{64}$/.test(String(sha256)) ? `DOC-${sha256.slice(0, 8).toUpperCase()}` : null, eventoId: d.eventoId, recebidoEm: l.recebidoEm ?? null, mime: l.mime ?? null, tamanhoBytes: l.tamanhoBytes ?? null, nomeArquivo: l.nomeArquivo ?? null,
    participanteId: l.participanteId ?? null, legenda: l.legenda ?? null, evidenciaUnidade: l.evidenciaUnidade ?? null, arquivoRemovido: Boolean(removida),
    conferencia: ultima ? { ...conf(ultima), versao: conferencias.length } : { estado: "AGUARDANDO_CONFERENCIA", tipo: null, obrigacaoId: null, observacao: null, por: null, em: null, versao: 0 },
    historico: conferencias.map(conf),
  });
}
