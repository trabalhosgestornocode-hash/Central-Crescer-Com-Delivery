# 34 — Matriz GO/NO-GO e plano de ativação: PRs #61, #62, #63 e a proposta de consolidação

Estado em 31/10/2026 13:40 BRT. **Nada foi mergeado, implantado ou aplicado em produção.** Cada passo abaixo pede a sua autorização expressa. Sem dado pessoal neste documento (o gerente do piloto é identificado por ID interno no relatório da conversa; o número de teste só entra no Render).

## 1. Matriz GO/NO-GO
| # | Item | Veredito | Evidência | Condição / o que falta |
|---|---|---|---|---|
| 1 | **PR #61** (docs) | **GO** | 5 arquivos só de `docs/`; varredura de dado pessoal limpa; `MERGEABLE/CLEAN` | autorização de merge |
| 2 | **PR #63** (D-1: não reagendar além do vencimento) | **GO** | diff de produção = 1 função pura + seu uso; sem migration; backend 5839 testes / 24 falhas já existentes / **0 novas**; 11 testes novos; PG 11/11 (`rate_limit_d1.sh`) | autorização de merge; reversão por `git revert`; **não** altera cota, destinatários, horários nem reabre mensagens |
| 3 | **Migration 139 em produção** | **GO técnico** (aguarda sua autorização) | pacote íntegro (SHA-256), pré-voo OK, backup físico do dia, validador 10/10, PG 25/25, Supabase de teste, rollback testado — **doc 36** | autorização expressa; **não** liga piloto, convites nem SAIR |
| 4 | **PR #62** (piloto, allowlist, SAIR + 139) | **NO-GO até a 139 estar aplicada e validada**; depois **GO** | regressão 5854 testes / 24 já existentes / **0 novas**; frontend 1649/0; revisão de código aplicada; com tudo desligado nada muda (teste do padrão de produção) | ordem: 139 → validar → merge do #62 |
| 5 | **Piloto Subway Saci — Matriz** | **NO-GO** | unidade e gerente (`unit_manager`) identificados; allowlist com o número homologado (só no Render) | (a) você confirmar o gerente; (b) **autorização do titular** do número; (c) **termo v2 aprovado** (doc 33: JUR-1, 2, 4, 5, 7 bloqueiam) |
| 6 | **SAIR real + confirmação** | **NO-GO** | implementados e testados, desligados | JUR-6 (palavras, prazo, texto) e sua autorização para `NOTIFICACOES_PALAVRA_CHAVE_SAIR`/`_SAIR_CONFIRMACAO` |
| 7 | **Consolidação por telefone** (branch `proto/d1-consolidacao-por-telefone`, doc 35) | **NO-GO para produção** (proposta homologada em isolamento) | módulo puro, 18 testes, PG 16/16; nenhum código de produção o usa; cotas e envio atuais intactos | decisão sua + PR próprio que liga no envio (muda formato/quantidade de mensagens) |
| 8 | OTP permanente, convites reais, M3, corte do fuso | **NO-GO / permanecem desligados** | — | decisões próprias, fora desta entrega |

## 2. Ordem recomendada dos merges e da 139
1. **#61** (docs).
2. **#63** → deploy (≈ 2–3 min até `ifoodEvents` voltar a `active`). Verificar `/health` e, no próximo lote do D-1, que mensagens barradas por `RATE_LIMIT_DIA` aparecem como `CANCELLED/EXPIRADA` na hora; entregas iguais às de hoje. Reversão: `git revert`.
3. **Migration 139** (ritual do doc 36: pré-voo, SHA-256, backup, aplicação isolada, validador 10/10, comparação da linha de base; sem rollback automático).
4. **#62** → deploy. Tudo desligado ⇒ convites seguem 503 `CONVITES_DESLIGADOS`; OTP e SAIR desligados; a produção **não define** `NOTIFICACOES_OTP_TRANSPORTE=baileys`, então a allowlist obrigatória não tira nada do ar.
(#62 antes da 139 não causaria dano — o backend só lê a chave quando os convites estão ligados —, mas a regra aqui é 139 validada primeiro.)

## 3. Plano de ativação do piloto (cada passo com autorização própria; reversão = desfazer o passo)
**Pré-requisitos:** itens 1–4 acima concluídos; termo v2 aprovado (JUR bloqueantes resolvidos); você confirma o gerente; o titular autoriza o número.
1. **Publicar o termo v2** (inserir `versao = 2`, `rascunho = false`; imutável; correção = versão 3).
2. **Ligar a trava de unidade:** `insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '["00000000-0000-0000-0000-0000000000a1"]')` (Subway Saci — Matriz). Reversão: apagar a chave (o backend continua exigindo piloto por padrão).
3. **Render, num único salvamento:** `NOTIFICACOES_OTP_TRANSPORTE=baileys`, `NOTIFICACOES_OTP_BAILEYS_AUTORIZADO=true`, `NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164=<número homologado>`, `NOTIFICACOES_OTP_MAX_HORA=5`, `NOTIFICACOES_OTP_MAX_DIA=10`, `NOTIFICACOES_CONVITES_HABILITADOS=true`; e, só se o JUR-6 estiver aprovado, `NOTIFICACOES_PALAVRA_CHAVE_SAIR=true` e `NOTIFICACOES_SAIR_CONFIRMACAO=true`. Reversão: remover as variáveis.
4. **Execução com o gerente autorizado (`unit_manager` da unidade):** convidar o número de teste → código → verificação → termo → categorias → 1 notificação autorizada → testar SAIR → conferir auditoria, reservas e que **uma tentativa de convite para outra unidade dá 403**.
**Critérios de sucesso:** 0 `FALHOU/INCERTO` inesperados; hash dos 41 destinatários e a fila do D-1 idênticos; nenhum convite fora da unidade; SAIR revoga só o número testado.

## 4. RATE_LIMIT — recomendação final (doc 32) e consolidação (doc 35)
**Consolidar por telefone.** Os vínculos duplicados são **legítimos** (um responsável, 7 lojas = 7 empresas distintas; o banco só admite o mesmo telefone uma vez por empresa); limite específico por contato multiempresa exige tabela de exceções e ainda envia 7 mensagens; o teto global **não foi alterado**. A proposta (módulo puro, invariantes provadas) está isolada na branch `proto/d1-consolidacao-por-telefone`; ligá-la é um PR próprio com decisões listadas no doc 35 §4.

## 5. Decisões materiais que faltam
1. Autorizar os merges #61 → #63 → (139) → #62 e a aplicação da 139.
2. Confirmar o gerente do piloto e a autorização do titular do número de teste.
3. Jurídico: JUR-1, 2, 4, 5, 7 + textos 3, 6 e 8; depois autorizar a publicação do termo.
4. Consolidação por telefone: aprovar o desenvolvimento do PR que a liga (ou escolher outra opção do doc 32).
5. Ativação do piloto, depois de 2 e 3.
