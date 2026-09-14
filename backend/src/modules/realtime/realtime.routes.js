import { Router } from "express";
import * as controller from "./realtime.controller.js";

// Infraestrutura do tenant, não um módulo contratável — mesma categoria de
// `usuarios`/`unidade` em routes.js: montado dentro do router `tenant`
// (depois de `tenant.use(requireContexto)`), sem `requireModulo` próprio.
// Qualquer contexto válido pode pedir sua credencial Realtime; o que ela
// autoriza (quais tópicos) é sempre escopado ao MESMO contexto, nunca mais.
export const realtimeRouter = Router();

realtimeRouter.post("/credencial", controller.credencial);
