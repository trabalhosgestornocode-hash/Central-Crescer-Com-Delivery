import { Router } from 'express';
import * as c from './performance.controller.js';
export const performanceRouter = Router();
performanceRouter.get('/',c.listar);
performanceRouter.get('/unidades',c.unidades);
performanceRouter.get('/competencias',c.listar);
performanceRouter.get('/unidades/:unidadeId/competencias/:competencia',c.abrir);
performanceRouter.patch('/unidades/:unidadeId/competencias/:competencia',c.salvar);
