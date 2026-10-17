// Ponto de montagem do domínio (contrato Agente 1 ⇄ Agente 2): `gestao-financeira/index.js` (Agente 1) importa `dominioRouter` daqui.
// ATENÇÃO DE INTEGRAÇÃO: este arquivo importa o gate do Agente 1 (`middlewares/financeiro.js`), que só existe na branch dele.
// Por isso nenhum teste desta branch importa este arquivo; os testes usam `criarDominioRouter` com um gate injetado.
import { autorizarAcaoFinanceira } from "../../../middlewares/financeiro.js";
import { criarDominioRouter } from "./rotas.js";

export const dominioRouter = criarDominioRouter({ autorizar: autorizarAcaoFinanceira });
