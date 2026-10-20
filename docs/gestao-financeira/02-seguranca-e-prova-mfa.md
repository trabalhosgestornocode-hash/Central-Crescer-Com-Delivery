# Segurança do acesso financeiro — estado e prova pendente de MFA

## Modelo (implementado)
Três condições independentes, relidas no banco a cada requisição (`middlewares/financeiro.js`): módulo na empresa, módulo na unidade, concessão vigente do **perfil** na **unidade**. Sem herança por papel (`organization_admin` não recebe nada), sem bypass de impersonação, perfil de exibição nunca acessa. Revogar = `revogada_em` preenchido → a requisição seguinte já nega; a sessão operacional não é encerrada.

## Banco (migration 120, validada só em Postgres 17 local descartável)
RLS ligado+forçado, **zero policies**, `revoke all` de `public/anon/authenticated`; `service_role` com select/insert/update (sem delete). Triggers: unidade ∈ organização, perfil ativo e vinculado, **autoconcessão proibida**, concessão ativa única, alteração de identidade proibida, auditoria append-only. Pós-condição na própria migration aborta se houver acesso direto ou policy.

## Administração de concessões — BLOQUEADA por padrão
Condições para liberar (todas):
1. Provar em **projeto Supabase novo e descartável** (T3) que o JWT de um SuperAdmin com TOTP traz `aal=aal2` e `amr[]` com `{method:"totp", timestamp:<segundos>}` e que, após 10 min, um novo desafio atualiza o carimbo.
2. Confirmar que todo SuperAdmin tem fator verificado.
3. Só então definir `FINANCEIRO_CONCESSOES_HABILITADAS=true` (e a revisão do código `shared/mfaRecente.js`: métodos aceitos e unidade do timestamp).
Enquanto isso, conceder/revogar só por SQL controlado (os triggers e a trilha de auditoria continuam valendo).

## Lacunas conhecidas
- `exigirMfaSeExigido` (global) continua dormente; não foi alterado.
- A UI do SuperAdmin para concessões **não foi construída** (endpoints prontos).
- Usuário "somente financeiro" só afeta a navegação: os papéis operacionais da conta continuam existindo no backend; para remover o operacional de fato, a pessoa não deve ter vínculo operacional na unidade.
