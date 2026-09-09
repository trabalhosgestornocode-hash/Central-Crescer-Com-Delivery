import { asyncHandler } from '../../../shared/asyncHandler.js';
import { criarService } from './performance.service.js';
const service = req => criarService({ ...req.app.locals.adminDeps, hoje:req.app.locals.adminHoje });
export const listar = asyncHandler(async (req,res) => res.json({ data:await service(req).listar(req.query) }));
export const unidades = asyncHandler(async (req,res) => res.json({ data:await service(req).unidades() }));
export const abrir = asyncHandler(async (req,res) => res.json({ data:await service(req).abrir(req.params.unidadeId,req.params.competencia) }));
export const salvar = asyncHandler(async (req,res) => res.json({ data:await service(req).salvar(req.params.unidadeId,req.params.competencia,req.body,req.user.id) }));
