# 30 — Ativação simples por unidade (migração 0023) e roteiro das duas Subway

Situação (15/11): implementado e testado **só localmente**. Nada publicado, nenhuma migração aplicada em produção, nenhuma variável do Render alterada.

## 1. O que mudou

| Antes | Agora |
|---|---|
| Cada unidade pedia 1 administrador provisionado por atestante diferente + TOTP, e a liberação pedia outro TOTP | **Administrador financeiro corporativo** (por empresa) ativa **várias unidades numa chamada**, concede acessos por nível, sem atestante e sem TOTP a cada ato |
| `FV2_ESCRITA_HABILITADA=1` liberava a escrita de **toda** unidade já liberada | A escrita exige **também** `escrita_ativa` **da unidade** (`fv2_liberacao`). Padrão: desligada. O Açaí e as demais ficam como estão |
| Faltavam rotas/telas de conta, caixa, receita, a receber e plano | Rotas `contas/criar`, `caixa/abrir|operacao|fechar`, `vendas/registrar|pagamento|cancelar`, `recebiveis/registrar` + tela **Lançamentos** + painel `corporativo.html` |

Quem é administrador financeiro: tabela `fv2_administrador_corporativo` (banco, tabela guardada: a aplicação não lê nem escreve). Só entra por (a) outro administrador, ou (b) **primeiro da empresa**: administrador da empresa na plataforma + TOTP recente + `FV2_PROVISIONAMENTO_HABILITADO=1` (decisão de infraestrutura do proprietário). Ser administrador da plataforma **não** basta para liberar nem conceder.

Mantido: autenticação da Crescer, conta pessoal (não compartilhada), vínculo da pessoa com a unidade, escopo por empresa/unidade (RLS), **sem autoconcessão** (regra de tabela), revogação na operação seguinte, histórico imutável, homologar/reabrir com 2º fator.

## 2. Níveis de acesso (painel)

- **Consulta**: ver.
- **Operador**: ver, registrar, corrigir, cancelar (receitas, despesas, contas a pagar/receber, caixa).
- **Financeiro**: operador + conciliar, revisar, importar, configurar, fechar, documentos, aprovar/aplicar, reclassificar, vincular pagamento.
- Homologar, reabrir e conceder/revogar **não** entram em nível: ficam com o administrador corporativo (concessão) e com o 2º fator (homologar/reabrir).

## 3. Roteiro de publicação (cada passo exige autorização específica)

1. **Código**: push da branch e PR (hoje só local). Deploy do backend (`crescercomdelivery`) e do frontend.
2. **Banco**: aplicar `database/financeiro-v2/producao/atualizar.sql` como `postgres`, numa transação. Aditivo: 2 tabelas, 2 colunas, 7 funções, 1 política; nada é apagado. Já ensaiado em cluster que imita o Supabase (`node scripts/fv2/sondaAtualizacao.mjs`).
3. **Render** (backend): `FV2_ESCRITA_HABILITADA=1` (mecanismo geral; a escrita de cada unidade segue desligada até o painel) e, **temporariamente**, `FV2_PROVISIONAMENTO_HABILITADO=1`.
4. **Primeiro administrador** (você, logado na Crescer, com TOTP): abrir `/financeiro-v2/corporativo.html` → "Tornar-me administrador financeiro". Depois, desligar `FV2_PROVISIONAMENTO_HABILITADO`.
5. **Segundo administrador** (recomendado, pelo painel): quem administra não se concede acesso operacional; para **você** também lançar, outra pessoa administradora concede o seu acesso.
6. **Ativar as duas Subway**: painel → marcar *Subway Saci — Matriz* e *Subway North Shopping* → "Ativar unidades marcadas" (liga consulta + lançamentos). O Açaí não é tocado (lista só da empresa da sessão).
7. **Quem opera**: painel → seção 2 → escolher a pessoa e o nível, por unidade.
8. **Abertura**: tela **Lançamentos** → plano de contas, contas (banco/caixa), abertura de caixa; saldos em *Caixa e Bancos*; contas a pagar e valores a receber conforme o doc 29 (sem inventar saldos).

## 4. Desligar

Painel → "Desligar unidades marcadas" (vale na hora, nada é apagado) ou `FV2_ESCRITA_HABILITADA=0` (todas voltam a só consulta).

## 5. Limitações conhecidas

- O painel lista administradores e candidatos pelo identificador da conta (a plataforma não expõe nome por esta porta).
- Receita manual com **um** pagamento por formulário; vários pagamentos: usar o formulário de pagamento da venda (rota pronta, tela ainda não).
- Cofre de documentos continua desligado (doc 29, P6); transferência de unidades e DRE por unidade usam o que já existia.
- Riscos do doc 29 § 6 (autoridade co-localizada) permanecem.
