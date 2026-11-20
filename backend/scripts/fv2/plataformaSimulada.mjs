// PLATAFORMA SIMULADA — só local, dados SINTÉTICOS, nenhuma rede além de 127.0.0.1. Serve o frontend como a produção serve
// (arquivos com `Cache-Control: no-cache` + ETag e revalidação 304), responde a autenticação da plataforma (/api/config, sessão) e as
// APIs do Financeiro com o núcleo REAL em memória (o mesmo da demonstração). Serve para MEDIR a abertura do Financeiro em
// `?modo=plataforma` antes e depois de uma mudança, em condições idênticas. Não é produção: os tempos são deste computador.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { criarDemo, UNIDADES } from "./demoInterface.mjs";

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json" };

/**
 * @param {{pasta:string, porta?:number, relogio?:()=>Date, atrasoApiMs?:number}} p `pasta` = a pasta `frontend` a servir.
 * @returns {Promise<{url:string, porta:number, fechar:()=>Promise<void>, requisicoesDeApi:string[], falharProximas:(n:number)=>void}>}
 */
export async function iniciarPlataformaSimulada({ pasta, porta = 0, relogio = () => new Date("2026-11-25T15:00:00Z"), atrasoApiMs = 0, preparar = null, unidadeIndice = 0, atrasoPorRota = {} }) {
  const demo = await criarDemo({ relogio, ...(preparar ? { preparar } : {}) });
  const raiz = normalize(pasta);
  const requisicoesDeApi = [];
  let sessaoExpirada = false;
  let respostas401 = 0; // simulação de login vencido: toda rota financeira responde 401 SESSAO_EXPIRADA
  let falhasRestantes = 0; // simulação de indisponibilidade: as próximas N consultas de dados (não a sessão) respondem 503
  const json = (res, status, corpo, extra = {}) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }).end(JSON.stringify(corpo));
  const espera = (ms) => (ms > 0 ? new Promise((ok) => setTimeout(ok, ms)) : Promise.resolve());

  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (url.pathname === "/api/config") return json(res, 200, { supabaseUrl: "http://127.0.0.1/supabase-simulado", supabaseAnonKey: "chave-anon-simulada" });
      if (sessaoExpirada && url.pathname.startsWith("/api/v1/financeiro-v2/")) { respostas401 += 1; return json(res, 401, { erro: "SEM_SESSAO", motivo: "SESSAO_EXPIRADA", mensagem: "Sessão expirada (simulação)." }); }
      if (url.pathname === "/api/v1/financeiro-v2/sessao") {
        requisicoesDeApi.push("sessao");
        await espera(atrasoApiMs);
        const r = await demo.responder("/api/fv2/sessao", {}, "administrador");
        return json(res, r.status, { ...r.corpo, unidades: (r.corpo.unidades ?? []).filter((u) => u.id === UNIDADES[unidadeIndice].id), modo: "PLATAFORMA", csrf: null, escritaHabilitada: true, pessoasDemo: [] });
      }
      if (url.pathname.startsWith("/api/v1/financeiro-v2/api/")) {
        const caminho = `/api/fv2/${url.pathname.slice("/api/v1/financeiro-v2/api/".length)}`;
        requisicoesDeApi.push(`${caminho}?${url.searchParams.toString()}`);
        await espera(atrasoApiMs + (atrasoPorRota[caminho.slice("/api/fv2/".length)] ?? 0));
        if (falhasRestantes > 0) { falhasRestantes -= 1; return json(res, 503, { erro: "INDISPONIVEL", mensagem: "Serviço indisponível (simulação)." }); }
        // A unidade é SEMPRE a da sessão (como no servidor real): a do cliente é ignorada.
        const params = { ...Object.fromEntries(url.searchParams), unidade: UNIDADES[unidadeIndice].id };
        const r = await demo.responder(caminho, params, "administrador");
        return json(res, r.status, r.corpo);
      }
      // Ações (POST): o servidor real usa a unidade da sessão e a confirmação já dada na tela; aqui, o MESMO núcleo da demonstração.
      if (req.method === "POST" && url.pathname.startsWith("/api/v1/financeiro-v2/acoes/")) {
        const caminho = `/api/fv2/acoes/${url.pathname.slice("/api/v1/financeiro-v2/acoes/".length)}`;
        requisicoesDeApi.push(`POST ${caminho}`);
        const pedacos = []; for await (const p of req) pedacos.push(p);
        let corpo; try { corpo = JSON.parse(Buffer.concat(pedacos).toString("utf8") || "{}"); } catch { return json(res, 400, { erro: "ENTRADA_INVALIDA", mensagem: "Corpo inválido." }); }
        const { csrf } = (await demo.responder("/api/fv2/sessao", {}, "administrador")).corpo;
        const r = await demo.agir(caminho, { ...corpo, unidade: UNIDADES[unidadeIndice].id, confirmar: true }, "administrador", { csrf });
        return json(res, r.status, r.corpo);
      }
      if (url.pathname.startsWith("/api/")) return json(res, 404, { erro: "NAO_ENCONTRADO", mensagem: "Fora da simulação." });
      // Estático: /financeiro-v2/ → index.html; o resto, relativo à pasta `frontend`.
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const arquivo = normalize(join(raiz, rel));
      if (!arquivo.startsWith(raiz + sep)) return res.writeHead(403).end();
      const info = await stat(arquivo).catch(() => null);
      if (!info?.isFile()) return res.writeHead(404, { "content-type": "text/plain" }).end("não encontrado");
      const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
      const cab = { "content-type": TIPOS[extname(arquivo)] ?? "application/octet-stream", "cache-control": "no-cache", etag };
      if (req.headers["if-none-match"] === etag) return res.writeHead(304, cab).end();
      return res.writeHead(200, cab).end(await readFile(arquivo));
    } catch (e) {
      return json(res, 500, { erro: "FALHA", mensagem: String(e?.message ?? e) });
    }
  });
  await new Promise((ok) => servidor.listen(porta, "127.0.0.1", ok));
  const { port } = servidor.address();
  return { url: `http://127.0.0.1:${port}`, porta: port, requisicoesDeApi, falharProximas: (n) => { falhasRestantes = n; }, expirarSessao: (v = true) => { sessaoExpirada = v; }, respostas401: () => respostas401, fechar: () => new Promise((ok) => servidor.close(ok)) };
}
