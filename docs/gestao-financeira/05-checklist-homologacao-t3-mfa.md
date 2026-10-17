# Checklist de homologação T3 — MFA, concessões e isolamento (Supabase DESCARTÁVEL)

**Objetivo:** provar, num projeto novo e separado da produção, que as condições para ligar
`FINANCEIRO_CONCESSOES_HABILITADAS` são reais. **Enquanto este checklist não estiver 100% marcado e aprovado por escrito, a flag
permanece desligada** e conceder/revogar só existem como procedimento de emergência.

## 0. Pré-condições (bloqueantes)
- [ ] Projeto Supabase **novo**, criado só para isto, com nome que o identifica como descartável (ex.: `crescer-t3-descartavel`). Nenhum dado real.
- [ ] Marcador de ambiente gravado no banco (ex.: tabela/linha `ambiente_descartavel = true`) e verificado **antes** de qualquer escrita; os scripts recusam rodar se o marcador faltar.
- [ ] `backend/.env` de produção **fora do alcance**: usar um `.env.t3` próprio, nunca `--env-file=.env`. URL/chaves de produção não aparecem em nenhum arquivo da sessão.
- [ ] Aplicar as migrations existentes + **120** (e, na integração, a 121 do Agente 2) **somente neste projeto**.
- [ ] Autorização escrita do responsável para criar o projeto e aplicar as migrations.

## 1. Prova de MFA (AAL2 + 2º fator recente)
- [ ] Criar um SuperAdmin de teste e cadastrar TOTP.
- [ ] Capturar o JWT após login só com senha: `aal = "aal1"`; `amr` sem `totp`. → `avaliarMfaRecente` deve negar com `MFA_REQUERIDA`.
- [ ] Capturar o JWT após o desafio TOTP: `aal = "aal2"` e `amr` contém `{ method: "totp", timestamp: <segundos> }`. **Confirmar que `timestamp` é em SEGUNDOS** (hipótese de `shared/mfaRecente.js`) e o nome do método (`totp`).
- [ ] Aguardar > 10 min sem novo desafio: o mesmo JWT deve ser negado com `REAUTENTICACAO_RECENTE`; um novo desafio atualiza o carimbo.
- [ ] Refresh de token: confirmar se o `amr` preserva o carimbo do TOTP (se não preservar, a janela de 10 min fica menor que o esperado — registrar).
- [ ] Todo SuperAdmin real tem fator verificado **antes** de ligar a flag (senão ficam trancados fora das concessões).
- [ ] Registrar o resultado em documento datado (sem tokens): versão do Supabase Auth, claims observadas.

## 2. Prova ponta a ponta das concessões (flag LIGADA só neste ambiente)
- [ ] Conceder com AAL2 recente → 201; auditoria em `plataforma_auditoria` **e** em `gestao_financeira_concessoes_auditoria`.
- [ ] Conceder com AAL1 → 401 `MFA_REQUERIDA`; com AAL2 antigo → 401 `REAUTENTICACAO_RECENTE`; flag desligada → 403 `CONCESSOES_BLOQUEADAS`.
- [ ] Autoconcessão (perfil da própria conta) → 403 (serviço) e, por SQL direto, erro do trigger.
- [ ] Unidade de outra empresa → 400; perfil sem vínculo → erro do trigger; perfil `display_operator` → recusado.
- [ ] Revogar → a **próxima** requisição financeira do perfil recebe 403; a sessão **operacional** continua funcionando; `setores` deixa de listar `financeiro`.
- [ ] Concessão expirada → 403 sem intervenção.
- [ ] Impersonação (SuperAdmin entra como empresa) → financeiro 403 `FINANCEIRO_BLOQUEADO_IMPERSONACAO`.
- [ ] `organization_admin` sem concessão → 403 em todas as rotas `/gestao-financeira/*`.

## 3. Isolamento no banco (RLS, privilégios, superfícies)
- [ ] Com a chave `anon` e com um JWT `authenticated`: `select/insert/update/delete` em `gestao_financeira_concessoes` e `..._auditoria` → negado (REST).
- [ ] Mesmo teste para as tabelas do domínio do Agente 2 (121).
- [ ] RPC/GraphQL/views: `pg_graphql` não expõe as tabelas; nenhuma view/função nova concede acesso (`has_table_privilege`, `has_function_privilege` para `anon`/`authenticated`).
- [ ] Publicação Realtime não inclui essas tabelas.
- [ ] Duas empresas/duas unidades: leitura e escrita cruzadas → 0 linhas / erro.
- [ ] Perfil de exibição: nenhuma rota financeira; nenhuma linha.
- [ ] `get_advisors` (segurança) do Supabase sem alerta novo relacionado a estas tabelas.

## 4. Rollback e regressão
- [ ] `120_rollback.sql` recusa com concessão ativa / módulo habilitado; com tudo limpo, desfaz; reaplicar funciona.
- [ ] Executar o T1 e as suítes de integração (`npm run test:integracao` contra o **descartável**, com `.env.test-integracao` apontando para ele) sem regressão.
- [ ] Dashboard Operacional: smoke manual (login, seleção de unidade, Dashboard, Checklist, Dashboard iFood).

## 5. Critério de saída (todos obrigatórios)
1. Itens 0–4 marcados, com evidências arquivadas (sem segredos).
2. Revisão de `shared/mfaRecente.js` feita com as claims reais.
3. Aprovação escrita do responsável.
4. Só então: definir `FINANCEIRO_CONCESSOES_HABILITADAS=true` **no ambiente alvo**, nunca antes; habilitar o módulo para **um** cliente piloto por vez, com concessão explícita e motivo.

## Não faz parte deste checklist
Aplicar migrations em produção, habilitar usuários reais, `push`/`merge`/deploy — todos exigem autorização própria.
