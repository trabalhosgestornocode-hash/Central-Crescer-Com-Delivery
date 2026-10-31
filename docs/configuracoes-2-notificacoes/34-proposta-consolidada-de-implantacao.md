# 34 — Proposta consolidada de implantação: PRs #61, #62 e #63

Estado em 31/10/2026. **Nada foi mergeado, implantado ou aplicado em produção por esta proposta.** Cada passo abaixo pede a sua autorização própria.

## 1. O que cada PR contém
| PR | Conteúdo | Código de produção? | Migration | Evidências finais |
|---|---|---|---|---|
| **#61** | docs 28–29, 33, 34 e matriz do termo (só documentação; sem dado pessoal) | não | não | 5 arquivos de `docs/`, checks verdes |
| **#63** | guarda de vencimento no adiamento do D-1 (`decidirDestinoDoAdiamento`): mensagem cujo próximo horário passaria do `expira_em` encerra no ato como `CANCELLED/EXPIRADA` | sim (2 arquivos, ~30 linhas) | **não** | backend 5839 testes / 24 falhas já existentes / **0 novas**; 11 testes novos; PG 11/11; diff de produção revisado: não toca cotas, destinatários, horários nem mensagens existentes |
| **#62** | trava de convites por unidade (backend + gatilho), allowlist obrigatória, SAIR endurecido (+ confirmação opcional), docs 30–31 | sim | **139** (não aplicada) | ver §3 |

## 2. Ordem recomendada
1. **Mergear #61** (docs; sem efeito).
2. **Mergear #63** → deploy automático (≈ 2–3 min até `ifoodEvents` voltar a `active`). Sem migration. Verificação: `/health`; no próximo lote do D-1, mensagens barradas por `RATE_LIMIT_DIA` aparecem como `CANCELLED/EXPIRADA` **na hora** (e a lista de "agendadas para o futuro" deixa de crescer); entregas iguais às de hoje. Reversão: `git revert` do merge → redeploy.
3. **Aplicar a migration 139** em produção (mesmo ritual da 137/138: pré-voo somente leitura, backup físico do dia, SHA-256 do arquivo, aplicação isolada, validação, comparação da linha de base). SHA-256 `fa0a0288…b056`; função `a79b1619…`; gatilho `BEFORE INSERT` habilitado; sem a chave `convites_unidades_piloto` o gatilho **não tem efeito**. Reversão: `139_rollback.sql`.
4. **Mergear #62** → deploy. Com **todas as variáveis desligadas** (o estado atual) nada muda: convites seguem 503 `CONVITES_DESLIGADOS`, OTP desligado, SAIR desligado (teste "padrão de produção" cobre). A produção não define hoje `NOTIFICACOES_OTP_TRANSPORTE=baileys`, então a **allowlist obrigatória** não tira nada do ar.
(#62 pode ir antes da 139 sem dano — o backend só consulta a chave quando os convites estão ligados —, mas a ordem acima mantém a defesa do banco pronta primeiro.)

## 3. Testes do #62 (versão final, após a revisão de código)
- Backend: regressão completa comparada à `main` (ver o PR; 24 falhas já existentes, 0 novas) e frontend 1649/0.
- Migration 139: PostgreSQL descartável **25/25** (chave ausente; piloto [U1]; unidade fora; mistura; vazio; objeto; não-uuid; **`null` e número no array**; UPDATE livre; privilégios; revogação do SAIR isolada por número; rollback e rollback idempotente) e **Supabase de teste** (aplicada; hash idêntico ao do banco descartável; todos os formatos inválidos recusados; transação desfeita, sem resíduo).
- Fluxo completo isolado: convite → OTP (Baileys simulado, 1 envio) → verificação → termo aprovado → categorias → SAIR → auditoria sem número nem código.
- **Revisão de código** (medium) aplicada: corrigidos o `null` no array do piloto, o carimbo de "aguarde" antes da revogação, o `recebidoEm` ausente (agora fail-closed) e a chave da confirmação (por mensagem). Limitações conhecidas e aceitas: o "aguarde" de 10 min é por processo (a proteção forte é "já saiu de tudo", sem lock entre duas instâncias — pior caso: uma auditoria e uma confirmação a mais).

## 4. Piloto — Subway Saci — Matriz (nada ativado)
- Unidade inicial: **Subway Saci — Matriz**, id `00000000-0000-0000-0000-0000000000a1` (ativa; não é de teste).
- **Gerente autorizado:** o perfil `unit_manager` vinculado a essa unidade (identificado por **ID interno no relatório da conversa**, não neste repositório público). Falta a **sua confirmação** de que é ele.
- **Allowlist:** o número de teste já usado em 31/10 (valor só no Render, no passo de ativação; não consta de nenhum arquivo).
- **Pré-condições para ativar:** (a) titular confirma a autorização do número; (b) **termo v2 aprovado e publicado** (doc 33); (c) 139 aplicada e #62 no ar.
- **Ativação (um passo por vez, cada um com autorização):** inserir `convites_unidades_piloto = ["<id da unidade>"]` → publicar o termo → no Render: `NOTIFICACOES_OTP_TRANSPORTE=baileys`, `NOTIFICACOES_OTP_BAILEYS_AUTORIZADO=true`, `NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164=<número>`, tetos baixos (`_MAX_HORA`, `_MAX_DIA`), `NOTIFICACOES_CONVITES_HABILITADOS=true` (e SAIR: `NOTIFICACOES_PALAVRA_CHAVE_SAIR`, `NOTIFICACOES_SAIR_CONFIRMACAO`, se o jurídico aprovar JUR-6). Reversão: remover as variáveis e a chave.

## 5. RATE_LIMIT — recomendação final (doc 32)
**Consolidar por telefone**, preservando isolamento e autorização por empresa/unidade. Os vínculos duplicados **não são indevidos** (um mesmo responsável com 7 lojas, cada loja uma empresa); o limite específico por contato multiempresa exige tabela de exceções e ainda envia 7 mensagens. O teto global **não** foi alterado. A consolidação está como protótipo puro e testado em `proto/d1-consolidacao-por-telefone` (fora do #63); ligá-la é um PR próprio que muda formato e quantidade das mensagens — **decisão material sua** (validar o texto com as empresas).

## 6. Decisões que faltam (consolidadas)
1. Autorizar o merge do #61, #63 e #62 (um a um, na ordem do §2) e a aplicação da 139.
2. Confirmar o **gerente autorizado** do piloto e a **autorização do titular** do número de teste.
3. Jurídico: JUR-1, 2, 4, 5 e 7 (bloqueiam) + textos 3, 6 e 8; depois, autorizar a publicação do termo.
4. RATE_LIMIT: aprovar o desenvolvimento da consolidação por telefone (ou escolher outra opção do doc 32).
5. Ativação do piloto, depois de 2 e 3.
