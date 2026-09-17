// Ferramenta administrativa — SÓ visualização do QR já emitido pelo próprio
// processo gateway-whatsapp (Checkpoint C3). Roda dentro do Shell do PRÓPRIO
// serviço no Render (localhost:$PORT) — nunca alcança o Gateway de fora,
// porque ele é um Private Service sem endpoint público.
//
// Consulta GET /internal/whatsapp/qr (a mesma rota HMAC-protegida, sem
// cache, sem persistência — ver src/routes.js) por polling. NUNCA chama
// /internal/whatsapp/connect — isso continua sendo disparado pelo fluxo
// oficial (Backend -> BaileysGatewayProvider -> Gateway).
//
// REGRAS DURAS:
//   - a string CRUA do QR nunca é impressa, salva em arquivo, nem enviada a
//     lugar nenhum — só passa para `qrcode` (dependência local, versão
//     fixada, sem download dinâmico) que desenha o ASCII no terminal.
//   - timeout obrigatório (default 180s) — nunca fica rodando indefinidamente.
//   - para sozinho assim que o status vira CONNECTED.
//
// Uso: node scripts/mostrar-qr.mjs [timeoutSegundos]
import QRCode from "qrcode";
import { assinarRequisicao } from "../src/hmac.js";

// RENDERIZAÇÃO (Checkpoint C3, 2º ajuste): `QRCode.toString(qr, {type:
// "terminal"})` usa os 8 cores ANSI clássicos (SGR 40/47) — no Shell do
// Render, "preto" ANSI clássico é renderizado como cinza escuro e o
// contraste fica insuficiente para escanear. Correção: usar `QRCode.create()`
// (a matriz real de módulos, API confirmada em
// node_modules/qrcode/lib/core/qrcode.js#createSymbol — devolve
// `{ modules: { size, data } }`, onde `data` é um Uint8Array linha-a-linha,
// índice `y*size+x`, 1 = módulo escuro) e desenhar cada módulo manualmente
// com background RGB verdadeiro (SGR 48;2;r;g;b, 24-bit) — cor exata,
// independente de como o terminal remapeia os 8 cores clássicos.
const MODULO_ESCURO = "\x1b[48;2;0;0;0m  ";
const MODULO_CLARO = "\x1b[48;2;255;255;255m  ";
const RESET_LINHA = "\x1b[0m";
const MARGEM_MODULOS = 2; // quiet zone mínima ao redor, exigida para leitura confiável

/**
 * Desenha o QR usando a matriz real de módulos (não a saída pronta do
 * `qrcode` para terminal) — cada módulo em 2 colunas (proporção quase
 * quadrada em fontes de terminal), quiet zone branca de `MARGEM_MODULOS`
 * módulos nos 4 lados.
 * @param {string} qr string crua do QR (nunca logada por esta função)
 * @param {{errorCorrectionLevel?: string}} [opts]
 * @returns {string} ASCII/ANSI pronto para console.log — nunca contém `qr`
 */
export function renderizarQrTerminalTrueColor(qr, { errorCorrectionLevel = "M" } = {}) {
  const { modules } = QRCode.create(qr, { errorCorrectionLevel });
  const { size, data } = modules;
  const linhas = [];
  for (let y = -MARGEM_MODULOS; y < size + MARGEM_MODULOS; y++) {
    let linha = "";
    for (let x = -MARGEM_MODULOS; x < size + MARGEM_MODULOS; x++) {
      const dentroDaMatriz = x >= 0 && y >= 0 && x < size && y < size;
      const escuro = dentroDaMatriz && data[y * size + x];
      linha += escuro ? MODULO_ESCURO : MODULO_CLARO;
    }
    linhas.push(linha + RESET_LINHA);
  }
  return linhas.join("\n");
}

/**
 * @param {object} opts
 * @param {string} opts.segredo WHATSAPP_GATEWAY_SECRET
 * @param {string} opts.base ex.: http://127.0.0.1:8080
 * @param {number} [opts.intervaloMs]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.buscar] injeção para teste
 * @param {(qr: string) => Promise<string>|string} [opts.renderizarTerminal] injeção para teste
 * @param {(texto: string) => void} [opts.escrever] injeção para teste
 * @param {() => void} [opts.limparTela] injeção para teste
 * @param {(ms: number) => Promise<void>} [opts.esperar] injeção para teste (sem tempo real)
 * @param {() => number} [opts.agoraMs] injeção para teste
 */
export function criarVisualizadorQr({
  segredo,
  base,
  intervaloMs = 2000,
  timeoutMs = 180_000,
  buscar = fetch,
  renderizarTerminal = (qr) => renderizarQrTerminalTrueColor(qr),
  escrever = (texto) => console.log(texto),
  limparTela = () => console.clear(),
  esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  agoraMs = () => Date.now(),
} = {}) {
  if (!segredo) throw new Error("WHATSAPP_GATEWAY_SECRET ausente.");
  if (!base) throw new Error("base (URL local do Gateway) ausente.");

  async function chamar(caminho) {
    const headers = assinarRequisicao({ segredo, metodo: "GET", caminho, corpo: "" });
    const resp = await buscar(`${base}${caminho}`, { headers });
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, json };
  }

  /** @returns {Promise<"CONNECTED"|"TIMEOUT">} */
  async function rodar() {
    const inicio = agoraMs();
    let ultimoQrVisto = null;

    escrever("Aguardando QR (a string nunca é impressa — só o desenho)...");

    while (agoraMs() - inicio < timeoutMs) {
      const statusResp = await chamar("/internal/whatsapp/status");
      if (statusResp.status === 200 && statusResp.json?.status === "CONNECTED") {
        limparTela();
        escrever("Conectado — sessão pareada. Encerrando visualização de QR.");
        return "CONNECTED";
      }

      const qrResp = await chamar("/internal/whatsapp/qr");
      const qrAtual = qrResp.status === 200 ? (qrResp.json?.qr ?? null) : null;
      if (qrAtual && qrAtual !== ultimoQrVisto) {
        ultimoQrVisto = qrAtual;
        const desenho = await renderizarTerminal(qrAtual);
        limparTela();
        escrever(desenho);
        escrever("Escaneie com o WhatsApp do número de TESTE. Aguardando conexão...");
      }

      await esperar(intervaloMs);
    }

    escrever("Tempo limite atingido sem conectar.");
    return "TIMEOUT";
  }

  return { rodar };
}

// Execução direta via CLI — não roda ao importar este arquivo (é o que
// permite testar `criarVisualizadorQr` isoladamente, sem processo real).
if (import.meta.url === `file://${process.argv[1]}`) {
  const segredo = process.env.WHATSAPP_GATEWAY_SECRET;
  if (!segredo) {
    console.error("WHATSAPP_GATEWAY_SECRET ausente — este script só roda dentro do próprio ambiente do Gateway.");
    process.exit(1);
  }
  const porta = Number(process.env.PORT) || 8080;
  const timeoutSegundos = Number(process.argv[2]) || 180;
  const visualizador = criarVisualizadorQr({ segredo, base: `http://127.0.0.1:${porta}`, timeoutMs: timeoutSegundos * 1000 });
  visualizador.rodar().catch((e) => { console.error("Erro no visualizador de QR:", e.message); process.exit(1); });
}
