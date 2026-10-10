// Auxiliar de testes — monta os routers REAIS do tenant atrás de um contexto simulado e enumera TODAS as rotas.
//
// Serve para provar, rota por rota, o que um papel consegue (ou não) chamar. Em vez de confiar na lista que alguém
// lembrou de escrever, o teste percorre a pilha de cada router (Express 4) e dispara cada método/caminho.
//
// O contexto simulado entrega o que `requireAuth` + `requireContexto` entregariam (req.user, req.tenant, req.acesso),
// com TODOS os módulos contratados — assim só a PERMISSÃO (e o middleware do perfil de exibição) decide o resultado.
// Rotas que não exigirem permissão chegam ao handler; o Supabase aponta para uma porta fechada, então nada é gravado.
import express from "express";
import http from "node:http";
import { MODULOS } from "../../src/shared/modulos.js";
import { permissoesDoPapel } from "../../src/shared/permissoes.js";
import { errorHandler } from "../../src/middlewares/errorHandler.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));

const { produtosRouter } = await import("../../src/modules/produtos/produtos.routes.js");
const { insumosRouter } = await import("../../src/modules/insumos/insumos.routes.js");
const { cmvRouter } = await import("../../src/modules/cmv/cmv.routes.js");
const { dashboardRouter } = await import("../../src/modules/dashboard/dashboard.routes.js");
const { dashboardExecutivoRouter } = await import("../../src/modules/dashboard-executivo/dashboardExecutivo.routes.js");
const { bonificacaoMensalRouter } = await import("../../src/modules/bonificacao-mensal/bonificacaoMensal.routes.js");
const { usuariosRouter } = await import("../../src/modules/usuarios/usuarios.routes.js");
const { vendasRouter } = await import("../../src/modules/vendas/vendas.routes.js");
const { martinBrowerRouter } = await import("../../src/modules/martinbrower/martinbrower.routes.js");
const { ifoodRouter } = await import("../../src/modules/ifood/ifood.routes.js");
const { parserFoodDeliveryRouter } = await import("../../src/modules/parser-food-delivery/parserFoodDelivery.routes.js");
const { agenteRouter } = await import("../../src/modules/agente/agente.routes.js");
const { inteligenciaRouter } = await import("../../src/modules/inteligencia/inteligencia.routes.js");
const { unidadeRouter } = await import("../../src/modules/unidade/unidade.routes.js");
const { realtimeRouter } = await import("../../src/modules/realtime/realtime.routes.js");
const { checklistOperacionalRouter } = await import("../../src/modules/checklist-operacional/checklistOperacional.routes.js");

/** Os routers montados dentro do `tenant` de routes.js (prefixo -> router). A trava de cobertura abaixo confere. */
export const MONTAGENS_TENANT = [
  ["/produtos", produtosRouter], ["/insumos", insumosRouter], ["/cmv", cmvRouter], ["/dashboard", dashboardRouter],
  ["/dashboard-executivo", dashboardExecutivoRouter], ["/bonificacao-mensal", bonificacaoMensalRouter],
  ["/usuarios", usuariosRouter], ["/unidade", unidadeRouter], ["/realtime", realtimeRouter], ["/vendas", vendasRouter],
  ["/integracoes/martin-brower", martinBrowerRouter], ["/integracoes/ifood", ifoodRouter],
  ["/checklist-operacional", checklistOperacionalRouter], ["/parser-food-delivery", parserFoodDeliveryRouter],
  ["/inteligencia", inteligenciaRouter], ["/agente", agenteRouter],
];

/**
 * Trava de cobertura: todo `tenant.use("/prefixo", ...)` de routes.js tem de estar em MONTAGENS_TENANT. Router novo
 * montado em routes.js sem entrar aqui faz o teste FALHAR — ninguém escapa da matriz de isolamento por esquecimento.
 */
export function prefixosMontadosEmRoutesJs() {
  const src = readFileSync(join(aqui, "..", "..", "src", "routes.js"), "utf8");
  return [...src.matchAll(/^tenant\.use\(\s*"(\/[^"]+)"/gm)].map((m) => m[1]);
}

const UUID = "11111111-1111-4111-8111-111111111111";

/** Todas as rotas (método + caminho com parâmetros preenchidos) de um router Express 4. */
export function rotasDoRouter(router, prefixo) {
  const saida = [];
  for (const camada of router.stack) {
    if (!camada.route) continue;
    for (const metodo of Object.keys(camada.route.methods)) {
      if (!camada.route.methods[metodo]) continue;
      const caminho = String(camada.route.path).replace(/:([A-Za-z0-9_]+)\??/g, UUID);
      saida.push({ metodo: metodo.toUpperCase(), caminho: `${prefixo}${caminho === "/" ? "" : caminho}` || "/", modelo: `${prefixo}${camada.route.path}` });
    }
  }
  return saida;
}

export function todasAsRotasDoTenant() {
  return MONTAGENS_TENANT.flatMap(([prefixo, router]) => rotasDoRouter(router, prefixo));
}

/**
 * App com o contexto simulado. `papel`/`permissoes` definem o contexto; `antes` (opcional) é o middleware extra
 * montado logo depois do contexto — é onde o teste coloca (ou não) `restringirPerfilExibicao`.
 */
export function montarAppDeIsolamento({ papel, permissoes = permissoesDoPapel(papel), antes = null, org = "aaaaaaaa-0000-4000-8000-00000000000a", unidade = "bbbbbbbb-0000-4000-8000-0000000000b1" }) {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: "cccccccc-0000-4000-8000-00000000000c", email: "conta@exemplo.test", nome: "Conta", superadmin: false, painelAdministrativo: false, ativo: true };
    req.tenant = { organizacaoId: org, unidadeId: unidade };
    req.perfil = { id: "dddddddd-0000-4000-8000-00000000000d", nome: "Perfil" };
    req.acesso = { sessionId: "eeeeeeee-0000-4000-8000-00000000000e", perfilId: req.perfil.id, papel, permissoes, modulos: Object.values(MODULOS),
      impersonadoPor: null, impersonando: false, empresa: { id: org, nome: "Empresa", status: "ativa" }, unidade: { id: unidade, nome: "Unidade" } };
    next();
  });
  if (antes) app.use("/api/v1", antes);
  // Sem requireModulo: o contexto simulado já tem TODOS os módulos, então só as permissões decidem o resultado.
  for (const [prefixo, router] of MONTAGENS_TENANT) app.use(`/api/v1${prefixo}`, router);
  app.use(errorHandler);
  return app;
}

/** Dispara uma requisição e devolve só o status (sem seguir corpo grande). Nunca lança. */
export function chamarStatus(server, { metodo, caminho }, { prazoMs = 4000 } = {}) {
  const { port } = server.address();
  return new Promise((resolve) => {
    const corpo = ["POST", "PUT", "PATCH"].includes(metodo) ? "{}" : null;
    const req = http.request({ host: "127.0.0.1", port, method: metodo, path: `/api/v1${caminho}`,
      headers: corpo ? { "content-type": "application/json", "content-length": Buffer.byteLength(corpo) } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.setTimeout(prazoMs, () => { req.destroy(); resolve("timeout"); });
    req.on("error", () => resolve("erro"));
    if (corpo) req.write(corpo);
    req.end();
  });
}
