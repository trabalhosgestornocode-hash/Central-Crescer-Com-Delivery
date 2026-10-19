# 22 — Checkpoint final consolidado e preparação da publicação (executor único: Agente 2)

Data: 2026-10-19 · Branch local **`final/financeiro`** (worktree `crescer-financeiro-final`). **Sem** push, PR, merge na `main`, deploy, migration remota, escrita no Supabase de testes, acesso a produção ou concessão real.
Legenda: **PRONTO** · **PRONTO COM RESTRIÇÃO** · **BLOQUEADO**. **Não há homologação independente:** a implementação e a verificação foram feitas pelo mesmo executor (Agentes 1 e 2 historicamente; agora só o 2).

## 1. Base e consolidação
- `origin/main` confirmada em `3545968` (`git ls-remote`). `integracao/financeiro-com-main` @ `2f3c14a` = `integracao/gestao-financeira` @ `5233380` + merge da `origin/main` (os 3 últimos commits do Agente 1 têm **patch idêntico** nas duas trilhas, `git range-diff`; o diff de todos os caminhos financeiros entre elas é vazio).
- `final/financeiro` nasce de `2f3c14a` e recebe, sem conflito, os commits do Agente 2: redesign premium, D-1 (período fechado) e acabamento visual; depois, os commits desta missão (compatibilidade organizacional, shell, catálogo, diagnóstico, documentação).
- `git merge-tree` da branch final com a `origin/main` atual: limpo (a `main` não andou desde o ensaio). Nenhuma outra branch local adiciona migration 120–122.

## 2. Estado por área
| Área | Estado | Evidência / restrição |
|---|---|---|
| Fundação de segurança, gate e permissões (empresa + unidade + concessão; leitura/operador/gestor) | **PRONTO COM RESTRIÇÃO** | jornada E2E 118/118 (botões × API 403 por nível), admin 23/23; papéis reais só no T3 |
| 12 telas (Visão Geral … Configurações) | **PRONTO** | QA premium 480/480; navegador real 17/17; integrado 56/56; navegação 39/39 |
| Motor financeiro (centavos, DRE, indicadores, regime de caixa) | **PRONTO** | backend `test/financeiro` e T1 sem falha financeira |
| Conciliação + M1 (banco autoritativo) | **PRONTO COM RESTRIÇÃO** | adversariais 70+5, R-1 → `fin_conciliacao_divergente`, paridade JS×SQL 631/631 e 1031/1031 (sementes 41 e 19); PostgREST real só no T3 |
| Fechamento mensal (F-1/F-2, impressão digital, 409) | **PRONTO COM RESTRIÇÃO** | F-1 31/31 (sessões reais), F-2 30/30; só fecha sem pendências |
| Integridade de mês fechado (D-1) | **PRONTO COM RESTRIÇÃO** | 25 FALHA antes → 44/44 depois; T3 pendente |
| Cancelamento de transferências | **PRONTO** | suíte do domínio + navegador real |
| Importação, relatórios e exportações CSV/XLSX | **PRONTO** | jornada (download real), integrado |
| Compatibilidade organizacional | **PRONTO COM RESTRIÇÃO** | 73/73 (inclui a brecha do UPDATE direto, fechada nesta missão); promoção já quebrada na `main` (pré-existente) |
| Migrations 120/121 | **PRONTO COM RESTRIÇÃO** | ciclo 18/18, catálogo 23/23, privilégios do Supabase simulados e conferidos contra o banco real de testes (doc 21) |
| Migration 122 | **PRONTO COM RESTRIÇÃO** | promovida em `database/migrations/122_conciliacao_periodos.sql` (corpo = o aplicado no T3; doc 24 §2); produção só com autorização |
| T3 | **EXECUTADO** (2026-10-19) | A0–A6 no banco de testes compartilhado; evidências e encerramento no doc 24 §6 e §9 |
| Concessões (acesso pela interface) | **BLOQUEADO (por desenho)** | flag `FINANCEIRO_CONCESSOES_HABILITADAS` desligada até o passo de MFA do T3 |
| Exceção de fechamento e reabertura | **desabilitadas (decisão)** | catálogo 12: `service_role` sem EXECUTE; sem rota/botão |

## 3. Mudanças desta missão
| Mudança | Arquivos | Prova |
|---|---|---|
| UPDATE genérico de `unidades.organizacao_id` deixava o histórico financeiro órfão → gatilho com a mesma guarda | `120_gestao_financeira_fundacao.sql` §5b, `120_rollback.sql`, `transferencia_unidades.{sql,sh}` | 8.10/8.13 FALHA antes → 73/73 depois; rollback devolve os gatilhos da `main` |
| Catálogo do T3 desatualizado desde `5233380` (as guardas precisam de EXECUTE do `service_role`) | `t3/verificacoes_catalogo.sql` | 22/23 → 23/23; a verificação 11 agora também **exige** o EXECUTE |
| Sombra da gaveta fechada vazava na borda esquerda (celular, todas as telas) | `frontend/src/styles.css` | QA: falha em 3 modos com o CSS antigo, passa com o novo |
| Seletor de unidade da barra superior com contraste 2,5:1 no escuro | `frontend/src/styles.css` | QA: 2,46 antes, ≥ 4,5 depois |
| Diagnóstico SQL somente leitura do banco de testes | `t3/diagnostico_leitura.{mjs,sql}` | 4 recusas testadas; execução real com `somente_leitura = on` |

## 4. Bateria local consolidada (dados sintéticos; PostgreSQL 17 descartável; Chrome real)
| Suíte | Resultado |
|---|---|
| Backend completo (T1, guarda de rede/.env) | 5 485 testes: 5 455 ok, 25 pulados, 5 falhas → 2 eram ambiente (`gateway-whatsapp/node_modules`; 28/28 depois) e **3 pré-existentes da `main`** (`performance-calc` "distribuições…", `sessao-perfil` "selecionarPerfil (Fase C)" ×2 — reproduzidas numa cópia limpa da `origin/main`) |
| Backend que lê migrations (68 arquivos) após a mudança na 120 | 557 ok, 0 falha |
| Frontend (`frontend/test`) | 1 550 / 1 550 |
| Navegador real, todos os módulos (8 suítes) | 101/106; as **5 falhas** (iFood "pedidos sem Financial" ×4, Parser FD "dia único") se repetem **idênticas** na `origin/main` limpa → pré-existentes, fora do Financeiro |
| QA premium (12 telas × 5 modos + modais + gráfico + erro/vazio + gaveta + barra superior) | **480/480** |
| QA integrado / F-2 / jornada E2E / navegação / admin | 56/56 · 30/30 · 118/118 · 39/39 · 23/23 |
| `sim_supabase.sh` / catálogo T3 | 37 OK / 23/23 |
| Adversariais 122 + complemento + D-1 | 70 + 5 + 44, 0 falha |
| R-1 / corrida M1 / F-1 concorrência | divergente (correto) / exit 0 / 31/31 |
| Paridade JS×SQL | 631/631 (300 aleatórios, semente 41) |
| Ciclo 120/121/122 (aplica, idempotência, rollback, reaplica) | 18/18 |
| Transferência/promoção × Financeiro (cadeia real da `main`) | 73/73 |
| Suíte de domínio PG (`run.sh`: SQL, B7/B8, cancelamento, concorrência, rollback) | ok |

## 5. Ordem real das migrations
`origin/main`: …110, 112–119, 123 (Checklist), 124, 125 (iFood). Financeiro: **120 → 121 → 122**, aplicadas **depois** das 123–125 em ambientes que já as têm (provado nos dois sentidos). Em produção a numeração não colide; o registro `supabase_migrations` não reflete o que foi aplicado pelo SQL Editor, então a conferência é por objeto (catálogo).

## 6. Preparação da publicação (nada executado)
**Configuração da v1:** módulo `gestao_financeira` nasce desabilitado (pós-condição da 120); `FINANCEIRO_CONCESSOES_HABILITADAS` ausente/`false`; exceção de fechamento sem EXECUTE para a aplicação e sem rota; reabertura sem rota, sem botão e sem EXECUTE; fechamento só sem pendências impeditivas; nenhuma concessão sem MFA validado e autorização específica.

**Sequência (cada passo com autorização própria):**
1. T3 no banco compartilhado (doc 21) — inclusive o passo de MFA.
2. Promover a 122 (`database/migrations/122_conciliacao_periodos.sql` com `begin/commit`, `lock_timeout`, rollback ao lado) e refazer a bateria.
3. PR de `final/financeiro` para a `main` (se a `main` andar: refazer `merge-tree` e a bateria) → revisão → merge.
4. Produção: cópia de segurança/PITR confirmado → janela → 120 → 121 → 122 como `postgres` → `verificacoes_catalogo.sql` (23 × `t`) → conferir que `modulos` ganhou só a linha 17.
5. Deploy da aplicação com o módulo desabilitado e a flag desligada. Conferir: demais módulos normais; rotas financeiras respondem 403 para todos.
6. Piloto: habilitar o módulo em **uma** unidade, ligar a flag, conceder a 1–2 perfis com MFA, acompanhar uma competência inteira.
7. Ampliar por unidade.

**Monitoramento inicial (primeiras 2 semanas do piloto):** taxa de 5xx em `/api/v1/gestao-financeira/*` (meta: 0); 409 `FIN_CONCILIACAO_DIVERGENTE` (meta: 0 — se aparecer, há divergência JS×SQL: suspender fechamentos e rodar a paridade); 409 `FIN_PERIODO_CONFLITO_*` (esperado só com edição simultânea); 403 por nível (esperado); erros 22023 na transferência de unidades (esperado para unidades com Financeiro); crescimento de `fin_auditoria` e `gestao_financeira_concessoes_auditoria` (toda concessão auditada).

**Reversão:** (a) aplicação: voltar ao deploy anterior no Render — o esquema financeiro fica inerte (módulo desabilitado, sem concessões); (b) acesso: desligar a flag e revogar concessões (doc 03); (c) banco: rollback 122 → 121 só **sem** dados financeiros; 120 só depois das duas. Com dados, a reversão é só da aplicação.

## 7. Bloqueios reais restantes
1. **T3 não executado** — precisa das autorizações A1–A6 do doc 21 (adaptação das travas, aplicar 120–122, semente, aceitar dados permanentes, usuário de teste com TOTP, encerramento).
2. **Promoção da 122, PR, merge e deploy** — autorizações separadas.
3. **Revisão independente ausente** — risco residual declarado; nenhuma área é "homologada".
4. **Fora do Financeiro (pré-existentes, decisão de outras frentes):** 115 não aplicada no banco de testes (RPCs de estrutura com EXECUTE público e 4 views legíveis sem login — risco e correção no doc 23 §1); promoção de unidade quebrada (42P10) na `main`; 3 testes de backend e 5 de navegador falhando na `main`.
