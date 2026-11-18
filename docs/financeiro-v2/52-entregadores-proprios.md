# Financeiro v2 — 52. Entregadores Próprios (Motoboys)

Situação: implementado só no ambiente local, na branch `feat/fv2-entregadores-proprios`. Nada foi publicado, nenhuma migração foi aplicada em produção e nenhuma flag foi alterada.

## 1. Diagnóstico do parser Foody Delivery

| Item | O que existe hoje |
|---|---|
| Localização | `backend/src/modules/parser-food-delivery/` (análise) e `backend/src/modules/foody/` (coleta) |
| Fonte dos dados | `parser_fd_pedidos` (planilha) e `foody_pedidos` (API). Por dia vale uma fonte só: a planilha prevalece |
| Identidade do entregador | Nome normalizado por unidade (`chaveEntregador`). `parser_fd_entregadores` é o cadastro; a API guarda também um hash |
| Identidade da entrega | `numero_pedido` + data e hora; na API, `foody_uid` |
| Taxa | `taxa_entregador`. Não é o valor cobrado do cliente |
| Estados | `situacao`, mais a classificação de cancelamento: recebe taxa, não recebe taxa ou revisar |
| Elegibilidade | Operação própria da unidade, com entregador, e `statusConciliacao` diferente de `excluido` |
| Ajustes | `parser_fd_lancamentos`: entrega manual, taxa adicional e movimentação avulsa |
| Correções | `parser_fd_pedido_overrides` sobrevive a reimportações. A coleta reprocessa D-1 a D-3 a cada 6 horas |
| Unidades | Todas as leituras filtram organização e unidade |
| Reutilização | `analisarPeriodo` e `carregarCoberturaFoody` são usados sem alteração |

## 2. Arquitetura

```
Parser Foody (somente leitura)
   └─ fonteEntregadores.js → porta `fonte` do núcleo
        ├─ semana em andamento: leitura ao vivo, valores provisórios, nada gravado
        └─ semana encerrada: fechamento em uma transação
              ├─ fv2_semana_entregadores (estado da semana)
              ├─ fv2_fechamento_entregador (retrato e conferência)
              └─ registrarObrigacao (Contas a Pagar, calendário e DRE existentes)
Baixa existente → guardaEntregadores.js → exige "Liberado para pagamento"
```

## 3. O que cada funcionalidade faz

| Funcionalidade | Impacto em português simples |
|---|---|
| Área Entregadores Próprios | Em **Operação → Entregadores Próprios** a equipe vê a semana inteira numa tela só |
| Cards por entregador | Mostram quanto cada um acumulou, por dia, e o que falta pagar |
| Acumulado provisório | O valor acompanha o parser, mas ainda não vira dívida |
| Fechamento automático | Na segunda, a partir das 06h, a semana fecha se a apuração estiver completa |
| Pendência de apuração | Dia sem dados, triagem ou cancelamento em revisão seguram o fechamento |
| Contas a Pagar | Nasce uma conta por entregador, unidade e semana, com vencimento na quarta |
| Idempotência | Reprocessar a semana nunca cria uma segunda conta |
| Conta manual parecida | O sistema para e pergunta antes de gerar, evitando pagar duas vezes |
| Demonstrativo | Lista entregas, ajustes e total, e pode ser copiado ou impresso |
| Pasta e notas | Cada semana guarda seus documentos. Arquivo substituído não é apagado |
| Conferência | Uma pessoa confere emitente, tomador, período, valor, número e duplicidade |
| Trava de pagamento | Sem liberação, nenhuma baixa passa, nem pela tela nem pelo extrato |
| Alteração tardia | Vira divergência para decisão. O valor original fica preservado |
| DRE | A despesa entra uma vez, em Entregadores Próprios. Pagar não repete a despesa |

## 4. Decisões assumidas

- **Competência:** a do último dia da semana, a mesma regra da formação financeira de entregadores. Uma semana que cruza o mês entra inteira no mês final.
- **Identidade entre unidades:** não há identificador comum e seguro. O mesmo nome em duas unidades continua separado.
- **Filtro de empresa e unidade:** a tela segue a unidade da sessão, como todo o Financeiro v2.
- **Permissões:** nenhuma ação nova. Fechar usa `registrar`, anexar usa `enviar_documento`, conferir e liberar usam `conciliar`, divergência usa `corrigir` e baixar arquivo usa `documentos`.

## 5. Testes executados

- `backend/test/financeiro-v2/entregadores-proprios.test.js`: 28 cenários, em memória e no PostgreSQL isolado.
- Suíte completa do Financeiro v2 e testes do parser.
- Navegador, com dados sintéticos (`backend/scripts/fv2/demoEntregadores.mjs`): fluxo da nota até a liberação, calendário, detalhe da conta e seis abas em 375 px sem rolagem lateral.

Não testado: dados reais do Açaí Saci, bucket real do Supabase e o agendador rodando em ambiente publicado.

## 6. Plano de publicação e segurança

Cada passo abaixo exige autorização própria.

1. Revisar e abrir o PR da branch. Com as flags desligadas, a tela existe, mas nada é gerado.
2. Aplicar `database/financeiro-v2/producao/atualizar.sql` (migração 0026). O pacote aborta se a produção não estiver exatamente na 0025.
3. Ligar a leitura e conferir uma semana real contra o Dashboard Operacional, sem gerar contas.
4. Definir `FV2_ENTREGADORES_INICIO` com a primeira segunda-feira automática. Semanas anteriores só fecham por reconciliação manual.
5. Decidir o armazenamento das notas: criar bucket **privado** e configurar `FV2_ENTREGADORES_BUCKET` e `FV2_ENTREGADORES_COFRE_ACEITO=1`.
6. Criar uma identidade de automação com concessão só de `ver` e `registrar` na unidade.
7. Configurar `FV2_ENTREGADORES_UNIDADES` só com o Açaí Saci e ligar `FV2_ENTREGADORES_AGENDADOR_HABILITADO=1`.
8. Acompanhar o primeiro fechamento real.

**Reversão:** desligar `FV2_ENTREGADORES_AGENDADOR_HABILITADO` interrompe novos fechamentos. As contas já criadas permanecem e seguem o fluxo normal do Financeiro.
