# MOVA × Financeiro 2.0 — inventário de capacidades e matriz de risco (incrementos 1 e 2)

Gerado do código do núcleo oficial (`backend/scripts/mova/inventarioCapacidades.mjs`): **182 operações**.
A permissão é a ação do Financeiro (`financeiro_v2.*`) encontrada no corpo da operação (leitura estática: "—" = leitura
sem ação explícita ou verificação feita num auxiliar; confirmar no teste antes de liberar).

Classes: LEITURA 77 · ADMINISTRATIVA 40 · FINANCEIRA 28 · CRÍTICA 37.

## Regras da matriz
- **LEITURA** (consultas, relatórios): identidade de LEITURA do MOVA; resposta segue a política do grupo (agregado/privado).
- **ADMINISTRATIVA** (cadastro, classificação, anexos, pendências): identidade OPERACIONAL com concessão da ação NAQUELA unidade +
  política (operação, empresa, unidade, valor, origem, evidência, perfil do solicitante).
- **FINANCEIRA** (baixas, conciliações, caixa, correções): idem + evidência exigida pela política + limite de valor + idempotência;
  ambíguo/divergente ⇒ revisão humana.
- **CRÍTICA** (estornos, cancelamentos, transferências, permissões, configuração, reabertura/fechamento): **nunca automática**;
  só aprovação humana específica no Dashboard. O MOVA não cria nem amplia política nem concessão (nenhuma operação de permissão
  está ao alcance da identidade operacional).
- Operação nova no núcleo sem classificação ⇒ PROIBIDA para o MOVA até ser classificada.

## Já integrado ao MOVA (coluna "MOVA hoje")
Consultas de contas/competência/caixa (identidade de leitura), proposta e aplicação humana de conta a pagar e despesa paga,
baixa por extrato com política (Frente C: `previaDoVinculoDoExtrato` → `enviarEvidencia` → `vincularPagamentoDoExtrato`,
reversão por `estornarLiquidacao` só por responsável), fluxo de entregadores (desligado em produção).

**Execução 17 — pagamento por comprovante × conciliação com o extrato** (núcleo: migração 0029; MOVA: 0009). Três operações novas:

| Operação | Capacidade | Classe | Permissão | MOVA hoje |
|---|---|---|---|---|
| `registrarPagamentoPorComprovante` | Baixar | FINANCEIRA | baixar_por_comprovante (+ enviar_documento para anexar) | sim (política BAIXA_DOCUMENTAL ou confirmação humana) |
| `conciliarPagamentoPorComprovante` | Conciliar | FINANCEIRA | vincular_pagamento | sim (candidata única + política BAIXA_POR_EXTRATO; senão a Central) |
| `consultarPagamentosPorComprovanteAConciliar` | Consultar | LEITURA | ver | sim |

Pago por comprovante = baixa SEM saída bancária (`movimentacao_id` nulo, origem COMPROVANTE, documento obrigatório).
A saída do extrato que chega depois é LIGADA à mesma baixa (nunca 2ª baixa/saída/despesa); enquanto houver pagamento por
comprovante a conciliar com o mesmo valor, `vincularPagamentoDoExtrato` e `registrarLiquidacao` da mesma conta são recusados.

| Operação | Capacidade | Classe | Permissão | MOVA hoje |
|---|---|---|---|---|
| `abrirCaixa` | Executar rotinas | CRITICA | registrar | — |
| `abrirDocumentoDoEntregador` | Executar rotinas | ADMINISTRATIVA | — | — |
| `alterarCategoria` | Atualizar | CRITICA | configurar | — |
| `alterarContaFinanceira` | Atualizar | CRITICA | configurar, conciliar | — |
| `alterarEstadoDaCompetencia` | Atualizar | CRITICA | ver | — |
| `alterarSituacaoOperadora` | Atualizar | CRITICA | configurar | — |
| `anexarDocumentoDoEntregador` | Criar (anexo) | ADMINISTRATIVA | — | sim |
| `aplicarConciliacaoIfood` | Revisar | FINANCEIRA | aplicar | — |
| `aplicarProposta` | Revisar | FINANCEIRA | aplicar, aprovar | — |
| `aplicarRelatorio99Food` | Revisar | FINANCEIRA | aplicar | — |
| `aprovarEAplicarProposta` | Revisar | FINANCEIRA | aprovar, aplicar, cancelar | — |
| `aprovarProposta` | Revisar | FINANCEIRA | aprovar, aplicar | — |
| `apurarCompetencia` | Gerar relatórios | LEITURA | — | — |
| `apurarVisaoGeral` | Gerar relatórios | LEITURA | — | — |
| `atribuirResponsavelDePendencia` | Atualizar | ADMINISTRATIVA | revisar | — |
| `atualizarAcompanhamentoDePendencia` | Atualizar | ADMINISTRATIVA | revisar | — |
| `cancelarExtraDoEntregador` | Reverter | CRITICA | corrigir | — |
| `cancelarObrigacao` | Reverter | CRITICA | cancelar | — |
| `cancelarRecebivel` | Reverter | CRITICA | cancelar | — |
| `cancelarVenda` | Reverter | CRITICA | cancelar | — |
| `classificarLancamentoIfood` | Classificar | ADMINISTRATIVA | configurar | — |
| `compararRelatoriosSaipos` | Revisar | LEITURA | — | — |
| `composicaoDoIndicador` | Gerar relatórios | LEITURA | — | — |
| `concederAcesso` | Permissões | CRITICA | conceder | — |
| `concluirAbertura` | Executar rotinas | CRITICA | configurar, reabrir | — |
| `conferirCofreDocumental` | Revisar | ADMINISTRATIVA | documentos | — |
| `configurarAbertura` | Atualizar | CRITICA | configurar | — |
| `configurarContaFinanceira` | Atualizar | CRITICA | configurar, registrar | — |
| `configurarFontesDeFaturamento` | Atualizar | CRITICA | configurar | — |
| `configurarUnidade` | Atualizar | CRITICA | configurar | — |
| `confirmarConciliacao` | Conciliar | FINANCEIRA | vincular_pagamento | — |
| `confirmarImportacao` | Importar | FINANCEIRA | confirmar_importacao | — |
| `consultarAbertura` | Consultar | LEITURA | — | — |
| `consultarCaixaEBancos` | Consultar | LEITURA | — | sim |
| `consultarCalendarioDeFaturamento` | Consultar | LEITURA | — | — |
| `consultarCalendarioFinanceiro` | Consultar | LEITURA | — | — |
| `consultarCanalPlataforma` | Consultar | LEITURA | — | — |
| `consultarCanalSaipos` | Consultar | LEITURA | — | — |
| `consultarCategoria` | Consultar | LEITURA | — | — |
| `consultarCentralDeConferencias` | Consultar | LEITURA | — | — |
| `consultarCompetencia` | Consultar | LEITURA | — | sim |
| `consultarComposicao` | Consultar | LEITURA | — | — |
| `consultarConferenciaSwf` | Consultar | LEITURA | — | — |
| `consultarConfiguracoes` | Consultar | LEITURA | — | — |
| `consultarContasAPagar` | Consultar | LEITURA | — | sim |
| `consultarContasAReceber` | Consultar | LEITURA | — | sim |
| `consultarCorrespondencias` | Consultar | LEITURA | — | — |
| `consultarDivergenciasDeVendas` | Consultar | LEITURA | — | — |
| `consultarDocumentos` | Consultar | LEITURA | documentos | — |
| `consultarDocumentosImportados` | Consultar | LEITURA | — | — |
| `consultarEntregador` | Consultar | LEITURA | — | sim |
| `consultarEntregadoresProprios` | Consultar | LEITURA | — | sim |
| `consultarFechamento` | Consultar | LEITURA | — | — |
| `consultarFechamentoManual` | Consultar | LEITURA | — | — |
| `consultarFluxoDeCaixa` | Consultar | LEITURA | — | sim |
| `consultarFontesDeFaturamento` | Consultar | LEITURA | configurar | — |
| `consultarHistorico` | Consultar | LEITURA | — | — |
| `consultarImportacao` | Consultar | LEITURA | — | — |
| `consultarImportacoesDoCanal` | Consultar | LEITURA | — | — |
| `consultarLiquidoEsperado` | Consultar | LEITURA | — | — |
| `consultarMovimentosDeCaixa` | Consultar | LEITURA | — | — |
| `consultarOperadoras` | Consultar | LEITURA | aplicar | — |
| `consultarPagamentosDeVendas` | Consultar | LEITURA | — | — |
| `consultarPendencias` | Consultar | LEITURA | — | — |
| `consultarPermissoes` | Consultar | CRITICA | conceder, revogar | — |
| `consultarPlanoDeContas` | Consultar | LEITURA | — | sim |
| `consultarPosicaoAReceber` | Consultar | LEITURA | — | — |
| `consultarPropostasParaRevisao` | Consultar | LEITURA | — | — |
| `consultarRecebiveisERepasses` | Consultar | LEITURA | — | — |
| `consultarReclassificacao` | Consultar | LEITURA | — | — |
| `consultarRegistros` | Consultar | LEITURA | — | — |
| `consultarResumoFinanceiro` | Consultar | LEITURA | — | sim |
| `consultarTaxasContratadas` | Consultar | LEITURA | — | — |
| `consultarTaxasEDescontos` | Consultar | LEITURA | — | — |
| `consultarTaxasPorOperadora` | Consultar | LEITURA | — | — |
| `consultarVendas` | Consultar | LEITURA | — | — |
| `consultarVersoesDeFechamento` | Consultar | LEITURA | — | — |
| `corrigirEntradaDePagamentoDeVenda` | Atualizar | FINANCEIRA | corrigir, cancelar | — |
| `corrigirLancamento` | Atualizar | ADMINISTRATIVA | corrigir | — |
| `corrigirObrigacao` | Atualizar | ADMINISTRATIVA | corrigir | — |
| `criarCorrespondenciaCandidata` | Conciliar | ADMINISTRATIVA | conciliar | — |
| `decidirCorrecao99Food` | Revisar | FINANCEIRA | confirmar_importacao | — |
| `decidirDivergenciaDoEntregador` | Revisar | FINANCEIRA | corrigir | — |
| `decidirNotaDoEntregador` | Revisar | FINANCEIRA | conciliar | sim |
| `detalharContaAPagar` | Consultar | LEITURA | — | sim |
| `detalharContaAReceber` | Consultar | LEITURA | — | — |
| `detalharCorrespondencia` | Consultar | LEITURA | — | — |
| `detalharDocumento` | Consultar | LEITURA | documentos | — |
| `detalharFechamentoDoEntregador` | Consultar | LEITURA | — | — |
| `detalharImportacao` | Consultar | LEITURA | — | — |
| `detalharPendencia` | Consultar | LEITURA | — | — |
| `detalharProposta` | Consultar | LEITURA | — | — |
| `detalharRecebimento` | Consultar | LEITURA | — | — |
| `detalharVenda` | Consultar | LEITURA | — | — |
| `documentarPendenciaDoFechamento` | Atualizar | ADMINISTRATIVA | fechar | — |
| `enviarEvidencia` | Criar (anexo) | ADMINISTRATIVA | enviar_documento | sim |
| `estornarLiquidacao` | Reverter | CRITICA | cancelar | sim |
| `estornarMovimentacao` | Reverter | CRITICA | cancelar, registrar | — |
| `estornarPagamentoDeVenda` | Reverter | CRITICA | cancelar, corrigir | — |
| `estornarTaxasDoPeriodo` | Reverter | CRITICA | cancelar | — |
| `estornarTransferencia` | Reverter | CRITICA | cancelar | — |
| `executarCicloDeEntregadores` | Executar rotinas | ADMINISTRATIVA | — | sim |
| `explicarDivergencia` | Revisar | ADMINISTRATIVA | revisar | — |
| `fecharCaixa` | Executar rotinas | CRITICA | registrar | — |
| `fecharSemanaDeEntregadores` | Executar rotinas | CRITICA | — | — |
| `gerarCandidatasDeConciliacao` | Conciliar | ADMINISTRATIVA | conciliar | — |
| `gerarCandidatasDeRepasseIfood` | Conciliar | ADMINISTRATIVA | conciliar | — |
| `gerarCandidatasObrigacaoMovimentacao` | Conciliar | ADMINISTRATIVA | conciliar | — |
| `gerarPropostas` | Executar rotinas | ADMINISTRATIVA | registrar | — |
| `implantarPlanoDeContas` | Atualizar | CRITICA | configurar | — |
| `iniciarConferenciaDaNota` | Executar rotinas | ADMINISTRATIVA | conciliar | sim |
| `lancarSangriasComoDespesa` | Criar | FINANCEIRA | registrar | — |
| `lancarSangriasSwf` | Criar | FINANCEIRA | registrar | — |
| `lerArquivoDoDocumento` | Consultar | LEITURA | — | — |
| `liberarPagamentoDoEntregador` | Liquidar | CRITICA | conciliar | — |
| `listarConcessoes` | Consultar | CRITICA | conceder, revogar | — |
| `listarMovimentosDaConciliacaoIfood` | Consultar | LEITURA | — | — |
| `listarPendenciasDeClassificacao` | Consultar | LEITURA | — | — |
| `listarPropostas` | Consultar | LEITURA | registrar | — |
| `listarRegistrosImportados` | Consultar | LEITURA | — | — |
| `listarVersoesDoDia99Food` | Consultar | LEITURA | aplicar | — |
| `marcarAguardandoDocumento` | Atualizar | ADMINISTRATIVA | conciliar | — |
| `obterArquivoDoDocumento` | Consultar | LEITURA | documentos | — |
| `pagarContaAPagar` | Liquidar | FINANCEIRA | registrar | sim |
| `previaDaConciliacaoIfood` | Consultar (prévia) | LEITURA | configurar | — |
| `previaDaMudancaDeEstado` | Consultar (prévia) | LEITURA | — | — |
| `previaDoDemonstrativoIfood` | Consultar (prévia) | LEITURA | — | — |
| `previaDoFechamentoSemanal` | Consultar (prévia) | LEITURA | — | — |
| `previaDoRelatorio99Food` | Consultar (prévia) | LEITURA | configurar | — |
| `previaDoVinculoDoExtrato` | Consultar (prévia) | LEITURA | — | sim |
| `previaSangriasComoDespesa` | Consultar (prévia) | LEITURA | — | — |
| `previaSangriasSwf` | Consultar (prévia) | LEITURA | — | — |
| `provisionarAdministradorInicial` | Permissões | CRITICA | — | — |
| `reabrirAbertura` | Reverter | CRITICA | reabrir, registrar | — |
| `reavaliarImportacao` | Importar | ADMINISTRATIVA | importar, confirmar_importacao | — |
| `receberArquivoParaImportacao` | Importar | ADMINISTRATIVA | importar | — |
| `reclassificarLancamento` | Classificar | ADMINISTRATIVA | reclassificar | — |
| `reconhecerPagamentoHistorico` | Liquidar | FINANCEIRA | conciliar | — |
| `reconhecerTaxasDoPeriodo` | Liquidar | FINANCEIRA | aplicar | — |
| `registrarAjuste` | Criar | FINANCEIRA | corrigir | — |
| `registrarCanalOuProcessador` | Criar | CRITICA | configurar | — |
| `registrarCategoria` | Criar | CRITICA | configurar | — |
| `registrarContraparte` | Criar | ADMINISTRATIVA | registrar | sim |
| `registrarDemonstrativoIfood` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarDiaSemOperacao` | Criar | CRITICA | configurar | — |
| `registrarDivergencia` | Criar | ADMINISTRATIVA | — | — |
| `registrarDivergenciaEntreFontes` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarDocumento` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarExtraDoEntregador` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarFaturamentoManual` | Criar | ADMINISTRATIVA | — | — |
| `registrarFechamentoManual` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarLiquidacao` | Criar | FINANCEIRA | registrar | — |
| `registrarMovimentacao` | Criar | FINANCEIRA | registrar | — |
| `registrarObrigacao` | Criar | ADMINISTRATIVA | registrar | sim |
| `registrarObrigacaoAnterior` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarOperacaoDeCaixa` | Criar | FINANCEIRA | registrar | — |
| `registrarOperadora` | Criar | CRITICA | configurar | — |
| `registrarPagamentoDeVenda` | Criar | FINANCEIRA | registrar | — |
| `registrarRecebivel` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarRecebivelAnterior` | Criar | ADMINISTRATIVA | registrar | — |
| `registrarSaldoDeAbertura` | Criar | FINANCEIRA | registrar | — |
| `registrarSaldoDeConta` | Criar | FINANCEIRA | registrar | — |
| `registrarTaxasContratadas` | Criar | CRITICA | configurar | — |
| `registrarTransferencia` | Criar | CRITICA | registrar | — |
| `registrarVenda` | Criar | ADMINISTRATIVA | registrar | — |
| `rejeitarCorrespondencia` | Conciliar | FINANCEIRA | — | — |
| `rejeitarImportacao` | Importar | FINANCEIRA | confirmar_importacao | — |
| `rejeitarProposta` | Revisar | FINANCEIRA | aprovar, aplicar | — |
| `resolverDivergenciaDeConciliacao` | Conciliar | FINANCEIRA | conciliar | — |
| `resolverDuplicidadeDoEntregador` | Conciliar | ADMINISTRATIVA | registrar | — |
| `resumoDoEntregadorDaConta` | Consultar | LEITURA | — | — |
| `reverterPropostaAgregada` | Reverter | CRITICA | cancelar | — |
| `revogarAcesso` | Permissões | CRITICA | revogar, conceder | — |
| `substituirAgregadoPorPedidos` | Atualizar | ADMINISTRATIVA | revisar | — |
| `substituirFaturamentoProvisorio` | Atualizar | ADMINISTRATIVA | — | — |
| `verificarAlteracoesDaSemana` | Revisar | LEITURA | — | — |
| `verificarConservacao` | Revisar | LEITURA | — | — |
| `verificarIntegridadeDoDocumento` | Revisar | LEITURA | documentos | — |
| `vincularDocumento` | Conciliar | ADMINISTRATIVA | registrar | — |
| `vincularExtraAoCaixa` | Conciliar | ADMINISTRATIVA | registrar | — |
| `vincularLoja99Food` | Conciliar | CRITICA | configurar | — |
| `vincularPagamentoDoExtrato` | Conciliar | FINANCEIRA | vincular_pagamento, corrigir | sim |
