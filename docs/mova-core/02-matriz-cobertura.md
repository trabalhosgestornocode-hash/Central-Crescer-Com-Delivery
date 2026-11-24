# MOVA CORE — matriz de cobertura (F0)

Gerada por `backend/scripts/mova/matrizCobertura.mjs` (não editar à mão). Fontes: inventário do núcleo, classificação de risco, portas do MOVA e ferramentas do Agente Crescer.

## Resumo

| Situação | Operações |
|---|---|
| DISPONIVEL | 24 |
| PARCIAL | 4 |
| PLANEJADA | 118 |
| RESTRITA | 46 |
| INEXISTENTE (pedido sem operação) | 4 |
| **Total do núcleo** | **192** |

## Por módulo do núcleo

| Módulo | DISPONIVEL | PARCIAL | PLANEJADA | RESTRITA |
|---|---|---|---|---|
| ? | 4 | 0 | 5 | 0 |
| abertura | 0 | 0 | 4 | 3 |
| acessos | 0 | 0 | 0 | 5 |
| apuracao | 1 | 0 | 2 | 0 |
| baixaAgrupada | 0 | 0 | 0 | 4 |
| baixaPorComprovante | 4 | 0 | 0 | 0 |
| baixaPorExtrato | 2 | 0 | 0 | 0 |
| caixa | 0 | 0 | 2 | 4 |
| calendarioFaturamento | 1 | 0 | 0 | 1 |
| canalPlataforma | 0 | 0 | 1 | 0 |
| canalSaipos | 0 | 0 | 1 | 0 |
| cofreDocumental | 1 | 0 | 3 | 0 |
| competencias | 1 | 0 | 7 | 1 |
| conciliacao | 0 | 0 | 6 | 0 |
| conciliacaoIfood | 0 | 0 | 5 | 0 |
| conferenciaSwf | 0 | 0 | 1 | 0 |
| conferencias | 1 | 0 | 11 | 0 |
| configuracoes | 0 | 0 | 2 | 3 |
| demonstrativoIfood | 0 | 0 | 2 | 0 |
| documentos | 0 | 0 | 2 | 0 |
| economico | 1 | 1 | 5 | 3 |
| entregadoresProprios | 4 | 0 | 10 | 2 |
| evidencias | 1 | 0 | 1 | 0 |
| extrasEntregadores | 0 | 0 | 2 | 1 |
| fechamentoManual | 0 | 0 | 4 | 0 |
| fontesDeFaturamento | 0 | 0 | 1 | 1 |
| formacao | 0 | 3 | 8 | 1 |
| importacoes | 0 | 0 | 9 | 0 |
| importacoesPorCanal | 0 | 0 | 1 | 0 |
| movimentosDeCaixa | 0 | 0 | 1 | 0 |
| plano | 1 | 0 | 0 | 3 |
| quantidadesDeEntregas | 0 | 0 | 0 | 1 |
| reclassificacao | 0 | 0 | 2 | 0 |
| relatorio99Food | 0 | 0 | 0 | 5 |
| sangriasComoDespesa | 0 | 0 | 1 | 0 |
| sangriasSwf | 0 | 0 | 1 | 0 |
| taxasContratadas | 0 | 0 | 3 | 4 |
| tesouraria | 1 | 0 | 4 | 2 |
| vendas | 0 | 0 | 5 | 2 |
| vendasRecebimentos | 1 | 0 | 6 | 0 |

## Ferramentas de leitura do Agente Crescer (fora do núcleo financeiro)

Hoje só no Agente Crescer (painel web). Situação para o MOVA: **PLANEJADA (F1)**, reaproveitadas como ferramentas de leitura com o mesmo escopo de unidade.

- `checklistOperacional`
- `dashboardDia`
- `dashboardExecutivo`
- `diagnostico`
- `evolucaoDiariaFinanceiro`
- `insumo`
- `insumosRanking`
- `navegacao`
- `parserCancelamento`
- `parserCancelamentos`
- `parserResumo`
- `produtoCmv`
- `produtosCmvRanking`

## Pedidos sem operação no sistema (INEXISTENTE)

| Pedido | O que existe hoje | Caminho |
|---|---|---|
| Sangria para compra futura com PRESTAÇÃO DE CONTAS pendente | tesouraria registra SANGRIA (registrarOperacaoDeCaixa) mas não há pendência de prestação de contas ligada à saída | F4: criar a pendência no núcleo (migração FV2) antes de o MOVA usar |
| Ligar despesa paga em dinheiro à SAÍDA de caixa e à sessão | lancarSangriasComoDespesa existe para importações; não há vínculo explícito despesa ↔ movimento da sessão por comando | F4: operação nova no núcleo, idempotente pela chave da saída |
| Vínculo participante do WhatsApp ↔ usuário da plataforma | o MOVA autoriza por participante_autorizado; não há ligação com o usuário/perfil da plataforma | F2: tabela de vínculo + confirmação pelo próprio usuário |
| Base de conhecimento aprovada (versão, origem, escopo, aprovador, revogação) | não existe | F5 |

## Operação por operação

| Operação | Módulo | Classe | Permissões | Situação | Como / quando |
|---|---|---|---|---|---|
| `abrirCaixa` | tesouraria | CRITICA | financeiro_v2.registrar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `abrirDocumentoDoEntregador` | entregadoresProprios | ADMINISTRATIVA | — | PLANEJADA | F3 (escritas administrativas com política) |
| `alterarCategoria` | plano | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `alterarContaFinanceira` | configuracoes | CRITICA | financeiro_v2.configurar, financeiro_v2.conciliar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `alterarEstadoDaCompetencia` | competencias | CRITICA | financeiro_v2.ver | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `alterarSituacaoOperadora` | taxasContratadas | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `anexarDocumentoDoEntregador` | entregadoresProprios | ADMINISTRATIVA | — | DISPONIVEL | escrita estreita (ENVIAR_DOCUMENTO, concessão + política + chave) |
| `aplicarConciliacaoIfood` | conciliacaoIfood | FINANCEIRA | financeiro_v2.aplicar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `aplicarProposta` | formacao | FINANCEIRA | financeiro_v2.aplicar, financeiro_v2.aprovar | PARCIAL | só proposta; aplicação humana no Dashboard |
| `aplicarRelatorio99Food` | relatorio99Food | — | financeiro_v2.aplicar | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `aprovarEAplicarProposta` | formacao | FINANCEIRA | financeiro_v2.aprovar, financeiro_v2.aplicar, financeiro_v2.cancelar | PARCIAL | só proposta; aplicação humana no Dashboard |
| `aprovarProposta` | formacao | FINANCEIRA | financeiro_v2.aprovar, financeiro_v2.aplicar | PARCIAL | só proposta; aplicação humana no Dashboard |
| `apurarCompetencia` | apuracao | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `apurarVisaoGeral` | apuracao | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `atribuirResponsavelDePendencia` | conferencias | ADMINISTRATIVA | financeiro_v2.revisar | PLANEJADA | F3 (escritas administrativas com política) |
| `atualizarAcompanhamentoDePendencia` | conferencias | ADMINISTRATIVA | financeiro_v2.revisar | PLANEJADA | F3 (escritas administrativas com política) |
| `cancelarExtraDoEntregador` | extrasEntregadores | CRITICA | financeiro_v2.corrigir | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `cancelarObrigacao` | economico | CRITICA | financeiro_v2.cancelar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `cancelarRecebivel` | economico | CRITICA | financeiro_v2.cancelar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `cancelarVenda` | vendas | CRITICA | financeiro_v2.cancelar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `classificarLancamentoIfood` | conciliacaoIfood | ADMINISTRATIVA | financeiro_v2.configurar | PLANEJADA | F3 (escritas administrativas com política) |
| `compararRelatoriosSaipos` | importacoes | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `composicaoDoIndicador` | apuracao | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `concederAcesso` | acessos | CRITICA | financeiro_v2.conceder | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `conciliarPagamentoPorComprovante` | baixaPorComprovante | FINANCEIRA | financeiro_v2.vincular_pagamento | DISPONIVEL | escrita estreita (VINCULAR_PAGAMENTO, concessão + política + chave) |
| `concluirAbertura` | abertura | CRITICA | financeiro_v2.configurar, financeiro_v2.reabrir | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `conferirCofreDocumental` | evidencias | ADMINISTRATIVA | financeiro_v2.documentos | PLANEJADA | F3 (escritas administrativas com política) |
| `configurarAbertura` | abertura | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `configurarContaFinanceira` | economico | CRITICA | financeiro_v2.configurar, financeiro_v2.registrar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `configurarFontesDeFaturamento` | fontesDeFaturamento | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `configurarUnidade` | configuracoes | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `confirmarConciliacao` | conciliacao | FINANCEIRA | financeiro_v2.vincular_pagamento | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `confirmarImportacao` | importacoes | FINANCEIRA | financeiro_v2.confirmar_importacao | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `consultarAbertura` | abertura | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarCaixaEBancos` | ? | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarCalendarioDeFaturamento` | calendarioFaturamento | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarCalendarioFinanceiro` | ? | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarCanalPlataforma` | canalPlataforma | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarCanalSaipos` | canalSaipos | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarCategoria` | configuracoes | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarCentralDeConferencias` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarCompetencia` | competencias | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarComposicao` | competencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarConferenciaSwf` | conferenciaSwf | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarConfiguracoes` | configuracoes | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarContasAPagar` | ? | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarContasAReceber` | ? | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarCorrespondencias` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarDivergenciasDeVendas` | vendasRecebimentos | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarDocumentos` | cofreDocumental | LEITURA | financeiro_v2.documentos | DISPONIVEL | leitura (identidade de leitura) |
| `consultarDocumentosImportados` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarEntregador` | entregadoresProprios | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarEntregadoresProprios` | entregadoresProprios | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarFechamento` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarFechamentoManual` | fechamentoManual | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarFluxoDeCaixa` | ? | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarFontesDeFaturamento` | fontesDeFaturamento | LEITURA | financeiro_v2.configurar | PLANEJADA | F1 (catálogo de leitura) |
| `consultarHistorico` | competencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarImportacao` | importacoes | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarImportacoesDoCanal` | importacoesPorCanal | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarLiquidoEsperado` | vendas | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarMovimentosDeCaixa` | movimentosDeCaixa | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarOperadoras` | taxasContratadas | LEITURA | financeiro_v2.aplicar | PLANEJADA | F1 (catálogo de leitura) |
| `consultarPagamentoAgrupado` | baixaAgrupada | — | — | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `consultarPagamentosDeVendas` | vendasRecebimentos | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarPagamentosPorComprovanteAConciliar` | baixaPorComprovante | LEITURA | financeiro_v2.vincular_pagamento | DISPONIVEL | leitura (identidade de leitura) |
| `consultarPendencias` | conferencias | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarPermissoes` | acessos | CRITICA | financeiro_v2.conceder, financeiro_v2.revogar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `consultarPlanoDeContas` | plano | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarPosicaoAReceber` | ? | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarPropostasParaRevisao` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarRecebiveisERepasses` | vendasRecebimentos | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarReclassificacao` | reclassificacao | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarRegistros` | competencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarResumoFinanceiro` | ? | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarTaxasContratadas` | taxasContratadas | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarTaxasEDescontos` | vendasRecebimentos | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarTaxasPorOperadora` | vendas | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `consultarVendas` | vendasRecebimentos | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `consultarVersoesDeFechamento` | competencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `corrigirEntradaDePagamentoDeVenda` | vendas | FINANCEIRA | financeiro_v2.corrigir, financeiro_v2.cancelar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `corrigirLancamento` | economico | ADMINISTRATIVA | financeiro_v2.corrigir | PLANEJADA | F3 (escritas administrativas com política) |
| `corrigirObrigacao` | economico | ADMINISTRATIVA | financeiro_v2.corrigir | PLANEJADA | F3 (escritas administrativas com política) |
| `criarCorrespondenciaCandidata` | conciliacao | ADMINISTRATIVA | financeiro_v2.conciliar | PLANEJADA | F3 (escritas administrativas com política) |
| `decidirCorrecao99Food` | relatorio99Food | — | financeiro_v2.confirmar_importacao | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `decidirDivergenciaDoEntregador` | entregadoresProprios | FINANCEIRA | financeiro_v2.corrigir | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `decidirNotaDoEntregador` | entregadoresProprios | FINANCEIRA | financeiro_v2.conciliar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `detalharContaAPagar` | tesouraria | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `detalharContaAReceber` | tesouraria | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `detalharCorrespondencia` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `detalharDocumento` | cofreDocumental | LEITURA | financeiro_v2.documentos | PLANEJADA | F1 (catálogo de leitura) |
| `detalharFechamentoDoEntregador` | entregadoresProprios | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `detalharImportacao` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `detalharPendencia` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `detalharProposta` | conferencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `detalharRecebimento` | vendasRecebimentos | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `detalharVenda` | vendasRecebimentos | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `documentarPendenciaDoFechamento` | competencias | ADMINISTRATIVA | financeiro_v2.fechar | PLANEJADA | F3 (escritas administrativas com política) |
| `enviarEvidencia` | evidencias | ADMINISTRATIVA | financeiro_v2.enviar_documento | DISPONIVEL | escrita estreita (ENVIAR_DOCUMENTO, concessão + política + chave) |
| `estornarLiquidacao` | caixa | CRITICA | financeiro_v2.cancelar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `estornarMovimentacao` | caixa | CRITICA | financeiro_v2.cancelar, financeiro_v2.registrar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `estornarPagamentoDeVenda` | vendas | CRITICA | financeiro_v2.cancelar, financeiro_v2.corrigir | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `estornarTaxasDoPeriodo` | taxasContratadas | CRITICA | financeiro_v2.cancelar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `estornarTransferencia` | caixa | CRITICA | financeiro_v2.cancelar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `executarCicloDeEntregadores` | entregadoresProprios | ADMINISTRATIVA | — | PLANEJADA | F3 (escritas administrativas com política) |
| `explicarDivergencia` | formacao | ADMINISTRATIVA | financeiro_v2.revisar | PLANEJADA | F3 (escritas administrativas com política) |
| `fecharCaixa` | tesouraria | CRITICA | financeiro_v2.registrar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `fecharSemanaDeEntregadores` | entregadoresProprios | CRITICA | — | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `gerarCandidatasDeConciliacao` | importacoes | ADMINISTRATIVA | financeiro_v2.conciliar | PLANEJADA | F3 (escritas administrativas com política) |
| `gerarCandidatasDeRepasseIfood` | conciliacaoIfood | ADMINISTRATIVA | financeiro_v2.conciliar | PLANEJADA | F3 (escritas administrativas com política) |
| `gerarCandidatasObrigacaoMovimentacao` | formacao | ADMINISTRATIVA | financeiro_v2.conciliar | PLANEJADA | F3 (escritas administrativas com política) |
| `gerarPropostas` | formacao | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `implantarPlanoDeContas` | plano | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `iniciarConferenciaDaNota` | entregadoresProprios | ADMINISTRATIVA | financeiro_v2.conciliar | PLANEJADA | F3 (escritas administrativas com política) |
| `lancarSangriasComoDespesa` | sangriasComoDespesa | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `lancarSangriasSwf` | sangriasSwf | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `lerArquivoDoDocumento` | importacoes | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `liberarPagamentoDoEntregador` | entregadoresProprios | CRITICA | financeiro_v2.conciliar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `listarConcessoes` | acessos | CRITICA | financeiro_v2.conceder, financeiro_v2.revogar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `listarMovimentosDaConciliacaoIfood` | conciliacaoIfood | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `listarPendenciasDeClassificacao` | formacao | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `listarPropostas` | formacao | LEITURA | financeiro_v2.registrar | PLANEJADA | F1 (catálogo de leitura) |
| `listarRegistrosImportados` | importacoes | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `listarVersoesDoDia99Food` | relatorio99Food | — | financeiro_v2.aplicar | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `marcarAguardandoDocumento` | conciliacao | ADMINISTRATIVA | financeiro_v2.conciliar | PLANEJADA | F3 (escritas administrativas com política) |
| `obterArquivoDoDocumento` | cofreDocumental | LEITURA | financeiro_v2.documentos | PLANEJADA | F1 (catálogo de leitura) |
| `pagarContaAPagar` | tesouraria | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `previaDaBaixaAgrupada` | baixaAgrupada | — | — | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `previaDaConciliacaoIfood` | conciliacaoIfood | LEITURA | financeiro_v2.configurar | PLANEJADA | F1 (catálogo de leitura) |
| `previaDaMudancaDeEstado` | competencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `previaDoDemonstrativoIfood` | demonstrativoIfood | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `previaDoFechamentoSemanal` | entregadoresProprios | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `previaDoRelatorio99Food` | relatorio99Food | — | financeiro_v2.configurar | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `previaDoVinculoDoExtrato` | baixaPorExtrato | LEITURA | — | DISPONIVEL | leitura (identidade de leitura) |
| `previaSangriasComoDespesa` | ? | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `previaSangriasSwf` | ? | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `provisionarAdministradorInicial` | acessos | CRITICA | — | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `quantidadesDeEntregas` | quantidadesDeEntregas | — | financeiro_v2.ver | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `reabrirAbertura` | abertura | CRITICA | financeiro_v2.reabrir, financeiro_v2.registrar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `reavaliarImportacao` | importacoes | ADMINISTRATIVA | financeiro_v2.importar, financeiro_v2.confirmar_importacao | PLANEJADA | F3 (escritas administrativas com política) |
| `receberArquivoParaImportacao` | importacoes | ADMINISTRATIVA | financeiro_v2.importar | PLANEJADA | F3 (escritas administrativas com política) |
| `reclassificarLancamento` | reclassificacao | ADMINISTRATIVA | financeiro_v2.reclassificar | PLANEJADA | F3 (escritas administrativas com política) |
| `reconhecerPagamentoHistorico` | entregadoresProprios | FINANCEIRA | financeiro_v2.conciliar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `reconhecerTaxasDoPeriodo` | taxasContratadas | FINANCEIRA | financeiro_v2.aplicar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarAjuste` | economico | FINANCEIRA | financeiro_v2.corrigir | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarCanalOuProcessador` | configuracoes | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `registrarCategoria` | plano | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `registrarContraparte` | economico | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarDemonstrativoIfood` | demonstrativoIfood | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarDiaSemOperacao` | calendarioFaturamento | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `registrarDivergencia` | conciliacao | ADMINISTRATIVA | — | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarDivergenciaEntreFontes` | formacao | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarDocumento` | documentos | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarExtraDoEntregador` | extrasEntregadores | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarFaturamentoManual` | fechamentoManual | ADMINISTRATIVA | — | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarFechamentoManual` | fechamentoManual | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarLiquidacao` | caixa | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarMovimentacao` | caixa | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarObrigacao` | economico | ADMINISTRATIVA | financeiro_v2.registrar, financeiro_v2.registrar_obrigacao | PARCIAL | só proposta; aplicação humana no Dashboard |
| `registrarObrigacaoAnterior` | abertura | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarObrigacaoDocumental` | economico | — | financeiro_v2.registrar_obrigacao, financeiro_v2.registrar | DISPONIVEL | escrita estreita (REGISTRAR_OBRIGACAO, concessão + política + chave) |
| `registrarOperacaoDeCaixa` | tesouraria | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarOperadora` | taxasContratadas | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `registrarPagamentoComEncargo` | baixaPorComprovante | — | financeiro_v2.baixar_por_comprovante | DISPONIVEL | escrita estreita (BAIXAR_POR_COMPROVANTE + REGISTRAR_JUROS, concessão + política + chave) |
| `registrarPagamentoDeVenda` | vendas | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarPagamentoPorComprovante` | baixaPorComprovante | FINANCEIRA | financeiro_v2.baixar_por_comprovante | DISPONIVEL | escrita estreita (BAIXAR_POR_COMPROVANTE, concessão + política + chave) |
| `registrarRecebivel` | economico | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarRecebivelAnterior` | abertura | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `registrarSaldoDeAbertura` | abertura | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarSaldoDeConta` | tesouraria | FINANCEIRA | financeiro_v2.registrar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `registrarTaxasContratadas` | taxasContratadas | CRITICA | financeiro_v2.configurar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `registrarTransferencia` | caixa | CRITICA | financeiro_v2.registrar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `registrarVenda` | vendas | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `rejeitarCorrespondencia` | conciliacao | FINANCEIRA | — | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `rejeitarImportacao` | importacoes | FINANCEIRA | financeiro_v2.confirmar_importacao | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `rejeitarProposta` | formacao | FINANCEIRA | financeiro_v2.aprovar, financeiro_v2.aplicar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `resolverDivergenciaDeConciliacao` | conciliacao | FINANCEIRA | financeiro_v2.conciliar | PLANEJADA | F4 (escritas financeiras com política e evidência) |
| `resolverDuplicidadeDoEntregador` | entregadoresProprios | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `resumoDoEntregadorDaConta` | entregadoresProprios | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `reverterPagamentoAgrupado` | baixaAgrupada | — | financeiro_v2.cancelar, financeiro_v2.vincular_pagamento | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `reverterPropostaAgregada` | formacao | CRITICA | financeiro_v2.cancelar | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `revogarAcesso` | acessos | CRITICA | financeiro_v2.revogar, financeiro_v2.conceder | RESTRITA | CRÍTICA: só aprovação humana no Dashboard |
| `substituirAgregadoPorPedidos` | formacao | ADMINISTRATIVA | financeiro_v2.revisar | PLANEJADA | F3 (escritas administrativas com política) |
| `substituirFaturamentoProvisorio` | fechamentoManual | ADMINISTRATIVA | — | PLANEJADA | F3 (escritas administrativas com política) |
| `verificarAlteracoesDaSemana` | entregadoresProprios | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `verificarConservacao` | competencias | LEITURA | — | PLANEJADA | F1 (catálogo de leitura) |
| `verificarIntegridadeDoDocumento` | cofreDocumental | LEITURA | financeiro_v2.documentos | PLANEJADA | F1 (catálogo de leitura) |
| `vincularDocumento` | documentos | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `vincularExtraAoCaixa` | extrasEntregadores | ADMINISTRATIVA | financeiro_v2.registrar | PLANEJADA | F3 (escritas administrativas com política) |
| `vincularLoja99Food` | relatorio99Food | — | financeiro_v2.configurar | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `vincularPagamentoAgrupado` | baixaAgrupada | — | financeiro_v2.vincular_pagamento | RESTRITA | sem classificação de risco ⇒ proibida até classificar |
| `vincularPagamentoDoExtrato` | baixaPorExtrato | FINANCEIRA | financeiro_v2.vincular_pagamento, financeiro_v2.corrigir | DISPONIVEL | escrita estreita (VINCULAR_PAGAMENTO, concessão + política + chave) |
