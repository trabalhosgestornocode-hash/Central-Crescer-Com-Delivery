# PR #236 — implantação, concessões, políticas e recuperação

**Situação:** preparado para revisão. **Nada disto foi aplicado em produção.** Migrações, concessões, políticas, merge, deploy e
recuperação de operações reais dependem de autorização específica, item por item.

Estado de produção usado aqui: consulta **somente leitura** de 27/11/2026 (projeto Supabase de produção).

## 1. Numeração das migrações

| Esquema | Em produção (27/11, nome + sha256 iguais ao Git) | Este PR adiciona | Fora deste PR |
|---|---|---|---|
| `financeiro_v2` | 0001–0032 (32 registradas) | **0033** `registrar_conta_parcelada`, **0034** `operacoes_entre_empresas` | — |
| `mova` | 0001–0018, 0020, 0022, 0023, 0024 | **0025** `contas_relatadas_intercompany_avisos` | 0019 e 0021 (só homologação, adiadas) |

Os pacotes `database/financeiro-v2/producao/atualizar.sql` e `database/mova-financeiro/producao/atualizar.sql` foram regerados
com essa base (`BASE_INSTALADA = "0032"`; `INSTALADAS_PARA_ATUALIZAR`). Cada pacote **confere nome e sha256** de todas as
instaladas e **aborta sem mudar nada** se o banco divergir, se alguma nova já estiver registrada, se for superusuário (FV2) ou
se for o banco de homologação (MOVA). `--conferir` dos dois geradores passa.

## 2. Antes de começar

1. **Backup**: snapshot/PITR do Supabase confirmado com horário anotado **imediatamente antes** do passo 3.1. Exportar também
   `financeiro_v2.fv2_concessao`, `mova.politica_autonomia`, `mova.proposta` (só leitura) para conferência posterior.
2. Repetir a consulta de inventário (`database/*/producao/inventario.sql`) e conferir que a base continua igual à da tabela acima.
3. Janela sem operação financeira manual em andamento; avisos diários e escrita do MOVA **desligados** até o passo 6.

## 3. Ordem de aplicação

Cada passo em **uma transação**, como `postgres`, e só com a autorização do passo.

| # | O quê | Arquivo | Confere depois |
|---|---|---|---|
| 3.1 | FV2 0033 + 0034 | `database/financeiro-v2/producao/atualizar.sql` | `fv2_migracao` com 34 linhas; `fv2_autorizacao_vinculada` existe e está vazia |
| 3.2 | MOVA 0025 | `database/mova-financeiro/producao/atualizar.sql` | `mova_migracao` com 0025; `mova.aviso_diario` existe |
| 4 | Concessão operacional do MOVA | `01-concessao-operacional-mova.sql` | select final: ações exatamente as listadas abaixo |
| 5 | Políticas Açaí e Subway | `02-politicas-acai.sql`, `03-politicas-subway.sql` | 8 políticas antigas intactas + 6 novas |
| 6 | Deploy do backend e do Gateway | Render | variáveis da seção 6 |

As migrações vêm **antes** do código: o código novo usa `registrar_conta_parcelada`, `registrar_intercompany` e
`fv2_abrir_sessao_vinculada`; o código antigo não referencia nada disso e continua funcionando com o banco novo.

## 4. Concessões

**Identidade operacional do MOVA** (`839a6da8…`), nas duas unidades, concedida por `63d66676…`:
`ver`, `baixar_por_comprovante`, `enviar_documento`, `registrar_juros`, `registrar_obrigacao` (já existentes) **+**
`registrar_conta_parcelada` **+** `registrar_intercompany`. **Sem `prestar_sangria`** (sangrias seguem suspensas) e **sem
nenhuma ação ampla** (`registrar`, `aplicar`, `corrigir`, `cancelar`, `conciliar`, `revisar`). O SQL é idempotente e confere
que 0033 e 0034 estão aplicadas.

**Pessoas** que aprovarão operações entre empresas no Centro Financeiro precisam de `registrar_intercompany` (junto de `aprovar` e
`aplicar`) **nas duas unidades**. Isso deve ser feito pela tela de concessões do Centro Financeiro (com 2º fator, auditado),
não por SQL. Candidatos com acesso às duas empresas hoje: `226f13f5…`, `63d66676…`, `beb9cb9f…`. **Quem recebe é decisão de
vocês.**

## 5. Políticas (preparadas, não ativas)

| Unidade | `CONTA_A_PAGAR_RELATADA` (conta única) | `CONTA_PARCELADA_RELATADA` | `OPERACAO_ENTRE_EMPRESAS` |
|---|---|---|---|
| Açaí | R$ 10.000,00 | R$ 10.000,00 | R$ 10.000,00 |
| Subway | R$ 30.000,00 | R$ 30.000,00 | R$ 30.000,00 |

Nível `APLICAR_COM_CONFIRMACAO` (a confirmação no WhatsApp é a confirmação humana), responsável João Pedro Pontes, vigência
a partir de 27/11. Entre empresas vale o **menor** limite das duas unidades (R$ 10.000,00 no par Açaí × Subway): a execução exige
política em vigor **nas duas** e ambas aceitando o valor. As 8 políticas existentes (Subway: baixa e despesa documental
R$ 30.000, juros R$ 1.000, sangria R$ 1.000; Açaí: R$ 10.000, R$ 10.000, R$ 500, R$ 1.000) não são alteradas.

## 6. Variáveis de ambiente

| Serviço | Variável | Valor |
|---|---|---|
| backend | `MOVA_OPERACAO_CRIAR_CONTAS` | já existente; precisa estar ligada para registrar contas relatadas e operações entre empresas |
| backend | `MOVA_AVISO_CONTAS_GRUPOS` | JIDs `…@g.us` dos grupos do aviso diário (vazio = desligado) |
| backend | `MOVA_AVISO_CONTAS_JANELAS` | `10:00,15:00` (padrão; horário de Fortaleza) |
| backend | `MOVA_GATEWAY_URL` / `MOVA_GATEWAY_SECRET` | já existentes (canal isolado do MOVA) |
| Gateway | `WHATSAPP_MOVA_GRUPOS_JID` | já existente; os grupos do aviso precisam estar nesta lista |

**Retrato dos membros:** o aviso só mostra valores se **todos** os membros do grupo forem FINANCEIRO num retrato recente. Retrato
com mais de 5 minutos ⇒ o backend pede um novo ao Gateway (`/internal/mova/membros`, somente leitura). Isso só existe com o
transporte **DIRETO** (`MOVA_GATEWAY_URL` na rede privada). Com o transporte pelo relé, o aviso sai mesmo assim, mas **sem
valores** quando não houve mensagem no grupo nos últimos minutos.

## 7. Ativação gradual

1. Deploy com `MOVA_AVISO_CONTAS_GRUPOS` vazio. Conferir os logs de inicialização do MOVA (sem `contradicoes`).
2. Uma conta relatada sintética de valor baixo num grupo de teste: pergunta de categoria → resumo → "não" (nada criado).
3. Ligar o aviso em **um** grupo; acompanhar 10h e 15h (`MOVA_AVISO_DIARIO_ENFILEIRADO`, `…RETRATO_ATUALIZADO`).
4. Só então a primeira conta real e a primeira operação entre empresas (seção 9).

## 8. Reversão (preserva os registros financeiros)

Não há reversão de esquema para FV2 0033/0034: elas criam ações, tabelas e funções que passam a ter registros de auditoria, e
apagar isso apagaria histórico. A reversão é **funcional**:

1. voltar o backend/Gateway para a versão anterior (o código antigo funciona com o banco novo);
2. revogar as políticas novas (`scripts/mova/politicasDaUnidade.mjs` gera o SQL de revogação; revogar é registro, não DELETE);
3. retirar `registrar_conta_parcelada` e `registrar_intercompany` da concessão operacional (nova versão da concessão);
4. esvaziar `MOVA_AVISO_CONTAS_GRUPOS`.

Contas, liquidações, vínculos entre empresas e auditoria criados até ali **permanecem**. Correções de lançamentos seguem o
fluxo normal do Centro Financeiro (estorno/cancelamento auditados). `database/mova-financeiro/recuperacao/reverter-0025.sql`
existe, mas **recusa** reverter se já houver proposta ou política das modalidades novas.

## 9. Recuperação das operações pendentes (estado de 27/11, só leitura — reconferir antes)

| Caso | Situação | Encaminhamento proposto |
|---|---|---|
| Mateus (Subway, R$ 464,30) | duas propostas: `8cb2101e` (comprovante Pix) e `b0ee87f7` (nota fiscal) | aprovar **só** `8cb2101e`, anexando o cupom como evidência; rejeitar `b0ee87f7` (mesma compra) |
| Distribuidora Açaí no Grau (Açaí, R$ 6.495,60, venc. 26/11, conta `3787a862`) | aberta; paga pela outra empresa | operação entre empresas: pela Central com autorização vinculada (pessoa com `registrar_intercompany` nas duas) ou reenviando o comprovante no WhatsApp depois do passo 5 |
| Bebedouro (Açaí) | **nenhum registro** em produção | relatar de novo; confirmar se R$ 194,50 é **cada parcela** ou o **total** e escolher a categoria (o MOVA pergunta; nunca escolhe imobilizado sozinho) |
| Coca (Subway) | contas `072dda45` (R$ 1.779,90) e `cf77dae7` (R$ 118,08), venc. 26/11, abertas | baixa normal quando houver comprovante |
| Ar-condicionado (Açaí, R$ 260,00) | proposta `cdfb86d4` pendente | revisão humana |
| Boleto Prefeitura de Teresina (Subway, R$ 1.090,61) | proposta `a6f07c8b` pendente | revisão humana |
| Falha de 27/11 | uma leitura terminou em `IA_RESPOSTA_TRUNCADA` | reenviar a mensagem; nada foi registrado |

## 10. Limites conhecidos

- **Despesa NOVA paga por outra empresa** (sem conta prévia na devedora) nunca é executada pelo WhatsApp: fica para aprovação
  humana, porque exigiria criar a conta. Também ficam para a Central os casos com várias contas compatíveis.
- **Aviso de conta que chegou** ("chegou o boleto de internet…", "boleto da contabilidade de setembro…") não é conta relatada:
  segue o fluxo antigo de proposta, com a competência **pendente** (nunca presumida pelo mês da mensagem). Conta relatada é a
  **compra** relatada (palavra de compra, parcelas ditas ou foto do produto), com competência no mês da compra.
- O relatório semanal dos entregadores não foi alterado neste PR.

## 11. Testes (PostgreSQL 17 local isolado, IA simulada, nada enviado ao WhatsApp)

Ver a descrição do PR para os números da última execução. A contagem de "838 testes FV2 em PostgreSQL" é a **mesma** suíte
`test/financeiro-v2` (em memória) executada de novo com `FV2_REPOSITORIO=postgres`; não é uma suíte separada.
