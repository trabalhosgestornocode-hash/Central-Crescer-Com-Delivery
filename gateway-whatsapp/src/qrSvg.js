// QR → SVG (aba Conexão do Painel). Gerado AQUI, no Gateway, a partir da matriz real de módulos do `qrcode` (a mesma API que scripts/mostrar-qr.mjs usa): o navegador
// recebe só uma imagem SVG e NÃO precisa de nenhuma biblioteca de terceiros (nem CDN) manipulando o segredo de pareamento. O front a exibe em <img>, onde um SVG
// não executa script. Puro e síncrono; devolve `null` (nunca lança) se o texto for inválido.
//
// O texto do QR nunca é logado, persistido nem devolvido dentro do SVG além de como padrão de módulos.

import QRCode from "qrcode";

const TAMANHO_MAX = 4096;   // limite de segurança do texto do QR (o real tem ~150-250 caracteres)

/**
 * @param {unknown} texto  a string crua do QR emitida pelo Baileys
 * @param {{margem?: number, escuro?: string, claro?: string}} [o]
 * @returns {string|null} SVG (sem script, sem referência externa) ou null
 */
export function qrParaSvg(texto, { margem = 2, escuro = "#17181c", claro = "#ffffff" } = {}) {
  if (typeof texto !== "string" || texto === "" || texto.length > TAMANHO_MAX) return null;
  try {
    const { modules } = QRCode.create(texto, { errorCorrectionLevel: "M" });
    const n = modules.size;
    const total = n + margem * 2;
    // uma trilha por linha, juntando módulos escuros contíguos (SVG pequeno, sem uma <rect> por módulo)
    let d = "";
    for (let y = 0; y < n; y += 1) {
      let x = 0;
      while (x < n) {
        if (!modules.data[y * n + x]) { x += 1; continue; }
        let fim = x;
        while (fim < n && modules.data[y * n + fim]) fim += 1;
        d += `M${x + margem} ${y + margem}h${fim - x}v1h-${fim - x}z`;
        x = fim;
      }
    }
    if (!/^#[0-9a-f]{6}$/i.test(escuro) || !/^#[0-9a-f]{6}$/i.test(claro)) return null;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * 8}" height="${total * 8}" shape-rendering="crispEdges" role="img" aria-label="QR Code de conexão do WhatsApp"><rect width="${total}" height="${total}" fill="${claro}"/><path d="${d}" fill="${escuro}"/></svg>`;
  } catch {
    return null;
  }
}
