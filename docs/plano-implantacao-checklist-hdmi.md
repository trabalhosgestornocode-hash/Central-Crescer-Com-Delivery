# Plano de implantação coordenada — Checklist via HDMI (perfil `display_operator`)

Estado: **preparado, nada executado**. Cada etapa exige autorização específica. A migration 115 já está em produção; a 116 (iFood) é independente e não é tocada aqui.

## Invariantes que a ordem precisa preservar

1. Nenhuma conta `display_operator` existe sem as migrations 112, 113 e 114 aplicadas.
2. Nenhuma rota nova é acessível antes de a restrição por perfil estar no ar. `POST /sessao/renovar` só aceita `display_operator`; os demais perfis recebem 403.
3. Sessões de usuários existentes não são tocadas: nenhum Context Token, `sessoes_contexto` ou claim muda para quem não é `display_operator`.
4. Nada altera conexões, credenciais, tokens ou configuração do iFood (a 116 e o PR #37/#38 ficam como estão). Events permanece desligado.

## Ordem recomendada

| # | Etapa | Por quê |
|---|---|---|
| 0 | Push da branch e abertura do PR; revisão; CI | Sem efeito em produção. |
| 1 | **Migrations 112 → 113 → 114, numa única janela**, com o mesmo pré-voo da 115 (projeto, backup, nada rodando, baixa utilização, SHA do arquivo) | Com as três aplicadas antes do código, o papel existe e já está bloqueado no RLS no mesmo instante. O código antigo não consegue criar a conta, então não há janela de conta sem RLS. 112 roda sem transação (enum); 113 e 114 são atômicas, com `lock_timeout`. |
| 2 | Merge do PR e deploy do backend (e do frontend, que no Render é manual) | Só então a interface permite criar o perfil. Rotas novas nascem restritas por perfil. |
| 3 | Definir `RENOVACAO_EXIBICAO_LIMITE_S` **antes** de criar a conta (ver abaixo) | Evita herdar o padrão de 20 h sem comprovação. |
| 4 | Criar UMA conta de exibição (unidade de teste), validar JWT real e TV | Fecha a pendência do teto. |
| 5 | Só depois, ampliar para outras unidades | |

Se a etapa 1 falhar, nada muda: 113 e 114 abortam inteiras. Se o código (etapa 2) tiver problema, o rollback do deploy é seguro porque nenhuma conta de exibição existe ainda.

Alternativa aceitável (código antes das migrations): também é segura, porque o endpoint de criação falharia no banco por falta do valor de enum. Foi preterida só porque deixa a interface exibir uma ação que ainda não funciona.

## Limite absoluto de 20 h (NÃO aprovado)

O `amr[].timestamp` do JWT real após refresh ainda não foi verificado (`docs/verificacao-jwt-supabase-conta-teste.md`, script `backend/scripts/verificar-jwt-amr.mjs`).

- Se o timestamp se mantiver estável após o refresh: o teto de 20 h contado da autenticação é sustentável.
- Se mudar a cada refresh: o teto de 20 h não se sustenta. Alternativa segura: sem renovação além do teto fixo de 8 h do Context Token (decisão 6A), com nova autenticação manual por turno.
- Enquanto não houver prova, **fixar o limite em valor conservador por configuração explícita** no Render. Não aumentar sem comprovação.

## Verificações pós-etapa

- Etapa 1: consulta read-only de catálogo (enum com o valor; constraint e índice; `auth_unidade_ids` sem o papel) e as impressões digitais do catálogo iguais fora desses objetos.
- Etapa 2: `/health` 200; `GET /api/v1/me` com usuário normal igual ao de antes; logs sem `permission denied`.
- Etapa 4: matriz de isolamento com a conta real (só a unidade vinculada; admin, financeiro e iFood devolvem 403; REST direto do Supabase sem dados).

## Rollbacks (último recurso, com autorização)

`112_rollback.sql`, `113_rollback.sql`, `114_rollback.sql` (arquivos ao lado das migrations). O rollback da 114 devolve à conta de exibição o acesso por RLS; só usar se não houver conta de exibição.
