// Superfície pública do Financeiro v2 (Execuções 01, 01B e 02).
// Este módulo NÃO está montado em nenhuma rota e NÃO importa nada de fora da própria pasta.
export { criarNucleoFinanceiro } from "./aplicacao/nucleo.js";
export { criarRepositorioMemoria } from "./infra/repositorioMemoria.js";
export { criarRepositorioPostgres } from "./infra/postgres/repositorioPostgres.js";
export { comprovarDestinoIsolado, exigirDestinoLocal } from "./infra/postgres/destinoSeguro.js";
export { criarCofreMemoria } from "./infra/cofreMemoria.js";
export { criarCofreDisco, criarRegistroDeAcessosNegadosEmDisco, criarRegistroDeAcessosNegadosMemoria, exigirPastaPrivada } from "./infra/cofreDisco.js";
export { criarAdaptadorDeSessao, criarConcessoesDoRepositorio, criarConcessoesMemoria } from "./aplicacao/sessao.js";
// Execução 09 — adaptador da sessão da PLATAFORMA e autoridade de provisionamento (puros; nada montado em rotas).
export { ACOES_COM_MFA_RECENTE, MOTIVO as MOTIVO_INTEGRACAO, avaliarAutenticacao, criarAdaptadorDaPlataforma, criarAutoridadeDaPlataforma, identificarSessao } from "./integracao/plataforma.js";
// Execução 09B — prova verificada de segundo fator, liberação por empresa/unidade e política do gateway.
export { JANELA_SEGUNDO_FATOR_MS, METODOS_DE_SEGUNDO_FATOR, MOTIVO_PROVA, criarVerificadorDeMfa, verificadorHs256 } from "./integracao/provaDeAutenticacao.js";
export { criarLiberacoesMemoria, validarAtoDeLiberacao } from "./integracao/liberacoes.js";
export { alterarLiberacaoPostgres, criarLiberacoesPostgres } from "./infra/postgres/liberacoesPostgres.js";
export { PERFIS_DE_ACESSO, criarAdministracaoCorporativaPostgres } from "./infra/postgres/administracaoPostgres.js";
export { FINALIDADE as FINALIDADE_DO_GATEWAY, decidirEmissao, eventoSemSegredos } from "./integracao/politicaDoGateway.js";
export { FONTES_PADRAO, criarRegistroDeFontes } from "./importacao/fontes/index.js";
export { analisarArquivo } from "./importacao/motor.js";
export { proporCandidatas } from "./importacao/correspondencias.js";
export { composicaoIfood } from "./importacao/fontes/ifood.js";
export { METODOS_DO_COFRE, conferirCofre } from "./contratos/cofre.js";
export { METODOS_DA_TRANSACAO, conferirTransacao, exigirRepositorio } from "./contratos/repositorio.js";
export * as planoDeContas from "./dominio/planoDeContas.js";
export * as comandos from "./contratos/comandos.js";
export * as catalogos from "./dominio/catalogos.js";
export * as dinheiro from "./dominio/dinheiro.js";
export * as tempo from "./dominio/tempo.js";
export { ACAO, autorizar, criarPoliticaDeEscopo, exigirContexto } from "./dominio/contexto.js";
export { CODIGO, ErroFinanceiro } from "./dominio/erros.js";
export { INDICADOR, compor } from "./dominio/indicadores.js";
export * as tesouraria from "./dominio/tesouraria.js";
export * as vendasRecebimentos from "./dominio/vendasRecebimentos.js";
export * as conferencias from "./dominio/conferencias.js";
export { CANAIS_PRINCIPAIS, METODOLOGIA, SITUACAO_INDICADOR, apurar, comoPercentual, participacoes } from "./dominio/apuracao.js";
