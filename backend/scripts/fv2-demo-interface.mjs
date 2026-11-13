// Servidor do AMBIENTE DEMONSTRATIVO LOCAL da interface do Financeiro v2 — só 127.0.0.1, dados sintéticos.
//   node scripts/fv2-demo-interface.mjs            → http://127.0.0.1:5179/
// Não lê .env, não abre banco, não é rota do aplicativo e não deve ser publicado.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { criarDemo } from "./fv2/demoInterface.mjs";

const PORTA = Number(process.env.FV2_DEMO_PORTA || 5179);
const PASTA = normalize(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "financeiro-v2"));
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const demo = await criarDemo();

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const cabecalhos = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  if (url.pathname.startsWith("/api/fv2/acoes/")) {
    // Ações LOCAIS da demonstração (06C): só POST com JSON pequeno, da própria origem, com token CSRF e confirmação explícita.
    // O corpo nunca é registrado em log.
    const json = (status, corpo) => res.writeHead(status, { ...cabecalhos, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(corpo));
    if (req.method !== "POST") { res.writeHead(405, cabecalhos).end(); return; }
    const origem = req.headers.origin;
    if (origem && origem !== `http://127.0.0.1:${PORTA}`) { json(403, { erro: "ORIGEM", mensagem: "Origem não permitida." }); return; }
    if (!/^application\/json(;|$)/.test(req.headers["content-type"] ?? "")) { json(415, { erro: "TIPO", mensagem: "Envie JSON." }); return; }
    let bruto = "";
    let excedeu = false;
    for await (const parte of req) { bruto += parte; if (bruto.length > 8192) { excedeu = true; break; } }
    if (excedeu) { json(413, { erro: "TAMANHO", mensagem: "Corpo grande demais." }); return; }
    let corpo;
    try { corpo = JSON.parse(bruto || "{}"); } catch { json(400, { erro: "JSON", mensagem: "JSON inválido." }); return; }
    const r = await demo.agir(url.pathname, corpo, req.headers["x-fv2-demo-sessao"], { csrf: req.headers["x-fv2-csrf"] });
    json(r.status, r.corpo);
    return;
  }
  if (url.pathname.startsWith("/api/fv2/")) {
    if (req.method !== "GET") { res.writeHead(405, cabecalhos).end(); return; }
    const r = await demo.responder(url.pathname, Object.fromEntries(url.searchParams), req.headers["x-fv2-demo-sessao"]);
    res.writeHead(r.status, { ...cabecalhos, "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(r.corpo));
    return;
  }
  const arquivo = normalize(join(PASTA, url.pathname === "/" ? "index.html" : url.pathname));
  const ext = arquivo.slice(arquivo.lastIndexOf("."));
  if (!arquivo.startsWith(PASTA + sep) || !TIPOS[ext]) { res.writeHead(404, cabecalhos).end("Não encontrado"); return; }
  try {
    res.writeHead(200, { ...cabecalhos, "content-type": TIPOS[ext], "content-security-policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com" }).end(await readFile(arquivo));
  } catch {
    res.writeHead(404, cabecalhos).end("Não encontrado");
  }
}).listen(PORTA, "127.0.0.1", () => console.log(`Financeiro v2 — demonstração local em http://127.0.0.1:${PORTA}/ (dados sintéticos)`));
