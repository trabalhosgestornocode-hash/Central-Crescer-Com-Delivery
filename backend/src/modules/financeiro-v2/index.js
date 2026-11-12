// Superfície pública do Financeiro v2 (fundação — Execução 01).
// Este módulo NÃO está montado em nenhuma rota e NÃO importa nada de fora da própria pasta.
export { criarNucleoFinanceiro } from "./aplicacao/nucleo.js";
export { criarRepositorioMemoria } from "./infra/repositorioMemoria.js";
export { METODOS_DA_TRANSACAO, conferirTransacao, exigirRepositorio } from "./contratos/repositorio.js";
export * as comandos from "./contratos/comandos.js";
export * as catalogos from "./dominio/catalogos.js";
export * as dinheiro from "./dominio/dinheiro.js";
export * as tempo from "./dominio/tempo.js";
export { ACAO, autorizar, criarPoliticaDeEscopo, exigirContexto } from "./dominio/contexto.js";
export { CODIGO, ErroFinanceiro } from "./dominio/erros.js";
export { INDICADOR, compor } from "./dominio/indicadores.js";
