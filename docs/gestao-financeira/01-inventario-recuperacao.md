# A1 — Inventário de recuperação (Agente 1)

Auditado em 2026-10-17 sobre `origin/main` = `8d32196` (merge do PR #46). Documento saneado: sem dados financeiros reais.

## Encontrado
| Item | Estado |
|---|---|
| `8d32196` | Existe; é o HEAD atual de `origin/main`. Coincide com a referência do planejamento anterior. |
| Branch `chore/testes-seguros-estabilizacao` | **Não existe** (local nem remota). Nenhum commit com "financ/testes-seguros/gestao" relacionado ao novo domínio. |
| `docs/gestao-financeira/` | Não existia (criada aqui). |
| `backend/testes-seguros/` | **Não existe** em `main` nem em `8d32196`. Precisa ser reconstruída. |
| Migration 120 | **Livre** (última: 119). |
| Repositório | **PÚBLICO** (`trabalhosgestornocode-hash/Central-Crescer-Com-Delivery`). |
| `planilhasveryimportants/` | Ignorada no `.gitignore` e sem arquivos rastreados. |

## Superfícies de autorização reais (verificadas no código)
- `backend/src/shared/permissoes.js`: `organization_admin = Object.values(P)` → **qualquer permissão adicionada a `PERMISSOES` é herdada automaticamente**. O namespace financeiro NÃO pode entrar em `PERMISSOES`.
- `backend/src/middlewares/auth.js`: `requirePermissao`, `requireAlgumaPermissao`, `requireModulo`, `requirePapel` **dão bypass quando `req.acesso.impersonando`**. Não servem para o financeiro; é preciso um middleware próprio que falhe fechado.
- Permissões e módulos ficam **congelados em `sessoes_contexto`** (≤ 8 h). Financeiro precisa reler a concessão no banco a cada requisição.
- MFA: `exigirMfaSeExigido` é **dormente** (flag de env); `requireAAL2` existe mas não é usado em lugar nenhum. Não há checagem de "autenticação recente" (só `authEm` extraído de `amr[].timestamp` para o perfil de exibição). Logo: **concessões ficam bloqueadas até a janela AAL2 ≤ 10 min ser comprovada em ambiente descartável**.
- `database/migrations/030`: `modulos.categoria check in ('operacao','integracao')` → a categoria `financeiro` exige alterar a constraint.
- Rotas de tenant são montadas em `backend/src/routes.js` (`tenant.use(requireContexto)` + `restringirPerfilExibicao` + `requireModulo` por router). O perfil de exibição só vê rotas de uma lista permitida.

## A reconstruir
Infra de testes segura (T1/T2/T3), contrato, módulo/concessões/migration, middleware financeiro, `GET /sessao/setores`, seleção de setor, alternador, menu financeiro, administração de concessões.

## Pendência independente (fora de escopo)
`novosClientesAcumulados` / Central de Performance (commit `15d0482`): não alterar nesta missão.
