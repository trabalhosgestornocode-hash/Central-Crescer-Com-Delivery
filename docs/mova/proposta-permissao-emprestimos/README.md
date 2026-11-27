# Proposta — permissão estreita para EMPRÉSTIMOS E FINANCIAMENTOS (fora da DRE)

**Situação: PROPOSTA. Nada aqui está aplicado.** A migração está em `0035_registrar_emprestimo.sql.rascunho`, fora de
`database/financeiro-v2/migracoes/` de propósito (o instalador de produção confere a lista exata de migrações). Enquanto ela não for
aprovada e aplicada, o principal de empréstimo relatado ou pago por boleto vira **proposta para aprovação na Central** (fluxo atual).

## Por que hoje não dá

A identidade operacional do MOVA tem só ações estreitas. O banco (`fv2_obrigacao_documental`, migrações 0030 e 0033) aceita, para elas,
apenas lançamento de natureza **DESPESA** (e IMOBILIZADO na conta relatada). O principal de empréstimo é **PATRIMONIAL**
(`EMPRESTIMOS_E_FINANCIAMENTOS`, "Empréstimos e financiamentos (principal)"), então a permissão estreita o recusa.

## O que a ampliação faz (e só isso)

Uma ação nova, **`financeiro_v2.registrar_emprestimo`**, que permite à identidade estreita:

1. registrar a conta a pagar de um empréstimo (relatada, 1 a 24 parcelas, em aberto), e
2. registrar o pagamento já feito por comprovante/boleto (conta + pagamento juntos, quitada),

**somente** na categoria `EMPRESTIMOS_E_FINANCIAMENTOS`. Qualquer outra categoria patrimonial continua recusada pelo banco:
distribuição de lucros, aportes e retiradas de sócios, operações entre empresas, valores de terceiros, títulos anteriores à abertura,
parcelamento tributário. Não dá `registrar` amplo, não dá `corrigir`/`cancelar`/`conciliar`, não paga nada por banco.

### Camadas (todas precisam concordar)

| Camada | Regra |
|---|---|
| Banco (migração 0035) | `registrar_emprestimo` na lista de ações; `fv2_so_registra_emprestimo()` (tem a ação e NÃO tem as amplas); o gatilho documental aceita `PATRIMONIAL` **só** com `categoria_codigo = 'EMPRESTIMOS_E_FINANCIAMENTOS'` e só para quem tem a ação |
| Financeiro v2 (código) | `ACAO.REGISTRAR_EMPRESTIMO`; `registrarContaParcelada`/`registrarDespesaPagaPorComprovante` aceitam essa categoria só com a ação |
| MOVA (código) | operações de política `EMPRESTIMO_RELATADO` e `EMPRESTIMO_DOCUMENTAL`, **sempre com confirmação no WhatsApp** (`APLICAR_COM_CONFIRMACAO`), limite por unidade |
| Concessão | pelo kit oficial da identidade operacional (por unidade, auditado), nunca à mão no banco |

## Sequência proposta (cada passo com autorização própria)

1. PR com o código (ação, regras do Financeiro e do MOVA, testes no PostgreSQL real com a identidade estreita: aceita empréstimo;
   recusa lucros, aportes, retiradas, entre empresas, terceiros, títulos anteriores e parcelamento tributário).
2. Homologação no banco de teste: aplicar a 0035, rodar os testes de banco.
3. Produção: backup → aplicar a 0035 → deploy → conceder `registrar_emprestimo` à identidade operacional (Subway e/ou Açaí) →
   criar as políticas com confirmação e limite.

Até o passo 3 terminar, nada muda em produção: o MOVA continua mandando empréstimos para aprovação na Central.
