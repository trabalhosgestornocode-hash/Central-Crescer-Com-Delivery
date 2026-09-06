import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config/env.js";
import { requireAuth } from "./middlewares/auth.js";
import { notFound } from "./middlewares/notFound.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { router } from "./routes.js";
import { corsOptions, helmetOptions, headersComplementares, LIMITES_CORPO, emProducao, cspEmModoBloqueio } from "./config/seguranca.js";
import { limiteDeTaxa } from "./shared/rateLimit.js";
import { RATE_LIMIT } from "./config/limites.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, "../../frontend");

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // O Render fica atrás de proxy: sem isto, req.ip é sempre o do proxy.
  if (emProducao) app.set("trust proxy", 1);

  // CSP montada a partir do que o frontend realmente usa — inclusive o
  // frame-src do portal Martin Brower. Sobe em Report-Only até CSP_ENFORCE=true.
  app.use(helmet(helmetOptions));
  // Headers que o helmet 7 não cobre (Permissions-Policy).
  app.use(headersComplementares);
  // CORS restrito por allowlist. Sem CORS_ORIGINS = só mesma origem.
  app.use(cors(corsOptions));

  // Limites de corpo POR ROTA. O teto de 30 MB existe apenas onde é
  // necessário (relatórios do SW em base64) em vez de valer para a API toda.
  // A primeira chamada que casar vence — express.json não reprocessa req.body.
  app.use("/api/v1/vendas/importar", express.json({ limit: LIMITES_CORPO.vendasImportacao }));
  // Cobre /importar/preview, /conciliar/preview e /conciliar/confirmar (todas
  // levam o relatório .xls/.xlsx inteiro em base64 no corpo) — sem isto caía
  // no limite `padrao` de 1 MB e falhava em qualquer relatório maior que uma
  // amostra pequena (achado real ao testar um relatório de ~3 MB/1578 pedidos).
  app.use("/api/v1/parser-food-delivery", express.json({ limit: LIMITES_CORPO.parserFoodDeliveryImportacao }));
  app.use("/api/v1/integracoes/martin-brower/import-manual", express.json({ limit: LIMITES_CORPO.martinBrowerImportacao }));
  // Bonificação Mensal — os 2 PDFs da Visio (Geral + Loja / Vendas + Produtos)
  // vão em base64 no mesmo corpo, tanto no LANÇAMENTO DIÁRIO (/importar,
  // /importar/preview) quanto no FECHAMENTO MENSAL (/fechamento-mensal,
  // /fechamento-mensal/preview). Sem o prefixo /fechamento-mensal aqui a F7
  // caía no limite `padrao` de 1 MB e todo "Analisar relatórios" com os 2 PDFs
  // devolvia 413 "Arquivo(s) grande(s) demais". /consolidar e /reabrir também
  // casam o prefixo — não levam PDF, então o teto maior é inofensivo.
  app.use(
    ["/api/v1/bonificacao-mensal/importar", "/api/v1/bonificacao-mensal/fechamento-mensal"],
    express.json({ limit: LIMITES_CORPO.bonificacaoMensalImportacao }),
  );
  app.use(express.json({ limit: LIMITES_CORPO.padrao }));

  app.use(morgan(emProducao ? "combined" : "dev", {
    skip: (req) => req.path === "/health",   // não polui o log com o probe
  }));

  // Frontend estático (shell público — a proteção real está na API de dados).
  // `.js`/`.html` nunca ficam em cache sem revalidar: os módulos do frontend
  // não têm nome versionado (sem hash no arquivo, ao contrário de um build
  // com bundler) — sem isso, o navegador pode continuar rodando uma versão
  // antiga de um arquivo já trocado no deploy até o cache expirar sozinho
  // (visto na prática: correção aplicada, usuário só via o comportamento
  // velho até dar um refresh "forçado"). Assets versionados por conteúdo
  // (imagens/fontes em /assets) continuam com o cache padrão do Express.
  app.use(express.static(frontendDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".js") || filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));

  app.get("/health", (_req, res) =>
    res.json({ ok: true, service: "subway-saci", ts: new Date().toISOString(), csp: cspEmModoBloqueio ? "enforce" : "report-only" })
  );

  // Config pública para o frontend inicializar o Supabase Auth (chave anon é pública por design)
  app.get("/api/config", (_req, res) =>
    res.json({ supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey })
  );

  // 🔒 A PARTIR DAQUI: toda rota de dados exige autenticação real (JWT do Supabase).
  app.use("/api/v1", requireAuth);
  // Teto grosseiro de requisições por CONTA autenticada — barra abuso/automação
  // sem atrapalhar uso normal (limite generoso, ajustável por env). Limites
  // mais apertados (PIN, senha, agente, importações) ficam nos routers.
  app.use("/api/v1", limiteDeTaxa({ escopo: "api:global", ...RATE_LIMIT.apiGlobal }));
  // Identidade do usuário — inclui `superadmin`, que é o que o frontend usa
  // para decidir entre o Painel SuperAdmin e a tela de seleção de empresa.
  // Não traz empresa alguma: isso é papel de /api/v1/sessao.
  app.get("/api/v1/me", (req, res) => res.json({ data: req.user }));
  app.use("/api/v1", router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
