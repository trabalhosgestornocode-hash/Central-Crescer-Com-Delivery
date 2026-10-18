# 17 — Checkpoint final: versão financeira integrada e estável (decisão de publicação)

Data: 2026-10-18 · Responsável único: Agente 1 (o Agente 2 está indisponível). **Nenhum push, PR, merge na `main`, deploy, migration remota, acesso a produção ou habilitação de concessão real.**
Branches locais: `integracao/gestao-financeira` (trilha financeira) e **`integracao/financeiro-com-main`** (trilha financeira + `origin/main` @ `3545968`, merge local `9d24d88`). Legenda: **PRONTO** · **PRONTO COM RESTRIÇÃO** · **BLOQUEADO**.

## 1. O que está efetivamente concluído
| Item | Estado | Observação |
|---|---|---|
| 12 telas (Visão Geral, Fluxo de Caixa/Lançamentos, Contas, Conciliação, DRE, Indicadores, Categorias, Plano de Contas, Períodos, Importação, Relatórios, Configurações) | **PRONTO** | jornada E2E 118/118; QA visual 56/56; navegador real 17/17 |
| API do domínio (53 rotas) + gate financeiro (empresa + unidade + concessão do perfil, sem bypass de impersonação) | **PRONTO** | HTTP integrado + domínio 241/241 |
| Matriz de permissões (leitura / operador / gestor; `reabrir` e `excluir` sem nível) | **PRONTO** | conferida tela × API na jornada (botões ausentes e API 403) |
| Migrations 120 (fundação) e 121 (domínio) | **PRONTO COM RESTRIÇÃO** | em `database/migrations/`; validadas em PG descartável com privilégios do Supabase simulados; **T3 pendente** |
| Migration 122 (conciliação, períodos, cancelamento, exceção, M1, O-1, F-1) | **PRONTO COM RESTRIÇÃO** | em `docs/gestao-financeira/proposta-122/` (**não promovida**); ciclo/rollback/reaplicação OK; T3 pendente |
| M1 (conciliação autoritativa no banco) | **PRONTO COM RESTRIÇÃO** | paridade 531/531 ×3 sementes; mutação 16/16; **F-3 fim-a-fim 8/8** com o código real; revisão independente ausente |
| O-1, F-1, F-2 | **PRONTO COM RESTRIÇÃO** | provas locais (catálogo 23/23, F-1 31/31 em sessões reais, F-2 30/30); revisão independente ausente |
| Relatórios e exportações CSV/XLSX | **PRONTO** | gate `ver`, isolamento por unidade, fórmulas neutralizadas, download real na jornada |
| Importação (prévia → confirmação) | **PRONTO** | navegador real; jornada confirma permissão por nível |
| Fechamento mensal (prévia, impressão digital, 409, snapshot imutável) | **PRONTO COM RESTRIÇÃO** | fecha sem pendências; com pendências só por exceção — fluxo de exceção **desabilitado** (ver §8) |
| Cancelamento de transferências (par atômico, motivo, auditoria) | **PRONTO** | suíte do Agente 2 + navegador real |
| Reabertura de período | **BLOQUEADO (por decisão)** | desabilitada em camadas; sem rota nem botão |

## 2. Bugs encontrados e corrigidos nesta missão
| Bug | Gravidade | Correção | Prova |
|---|---|---|---|
| **Truncamento silencioso de referências e resoluções** (`listarReferencias`/`listarResolucoes` com `.limit(5000)`; o PostgREST do Supabase corta em **1000**). Meses com mais de 1000 referências/resoluções: a conciliação da aplicação divergia da do banco e o fechamento ficava **bloqueado para sempre** (409; falha fechada, nunca fechava errado) | média (funcional) | paginação por `range` com desempate por `id` (`repositorio.conciliacao.js`) | antes: F-4 divergia (409); depois: app = banco e o mês **fecha**; teste novo `paginacaoConciliacao.test.js` (6) falha com o código antigo |
| Travas dos scripts SQL de T3 não paravam o script (`\quit`/erro dentro de `\ir` só encerra o arquivo incluído) | alta (segurança operacional do T3) | trava **inline** em cada script que escreve: exige `-v CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL` e recusa banco com organização real | provado: sem confirmação, com confirmação errada e com organização "real" ⇒ recusa e **nada é gravado** |
| Scripts shell de concorrência sem checar o cluster local | média | exigem `PG_CLUSTER_DIR` com `MARCADOR_DESCARTAVEL` e conferem `data_directory` | recusa sem a variável |
| QA de navegação com expectativa obsoleta ("em construção" na Visão Geral) | teste | expectativa atual: tela real, estado de erro honesto, nenhum número inventado | 39/39 |
Missões anteriores (já entregues e preservadas): R-1/M1, F-A, F-B, F-C, F-D, P-1, O-1, F-1, F-2, alertas ilegíveis no tema escuro, 120 com privilégios herdados do Supabase.

## 3. Testes executados (todos locais, dados sintéticos)
| Suíte | `integracao/gestao-financeira` | `integracao/financeiro-com-main` |
|---|---|---|
| Backend T1 completo (ambiente fictício, guarda de rede/.env) | 5 414 · 5 386 ok · 3 falhas conhecidas* | 5 487 · 5 458 ok · 3 conhecidas* (+1 intermitente**) |
| Provas da guarda T1 | 32/32 | — |
| Domínio + HTTP integrado (gate real) | **241/241** | **241/241** |
| Frontend (`frontend/test`) | 1 530 ok · 0 falhas | 1 553 ok · 0 falhas |
| Navegador real (Agente 2) | 17/17 | 17/17 |
| QA visual integrado / F-2 / **jornada E2E** / navegação / admin | 56/56 · 30/30 · **118/118** · 39/39 · 23/23 | 56/56 · 30/30 · 118/118 · 39/39 · 23/23 |
| PG descartável: ciclo 120→122 (+rollback/reaplicação) | OK | ordem com a 123 da main: **antes e depois** OK |
| Privilégios Supabase simulados / catálogo T3 | sem falhas / **23/23** | catálogo 23/23 nas duas ordens |
| Adversariais M1 (S0–S12) + complemento + corrida | 70 + 5 PASS, 0 FALHA | — |
| F-1 concorrência (sessões reais) | 31/31 | — |
| Paridade JS×SQL (2 organizações) | 531/531 ×3 | — |
| **F-3/F-4 fim-a-fim (código real da aplicação, teto de 1000 linhas)** | **10/10** | — |
| Suíte do Agente 2 (`run.sh`: domínio, B7/B8, cancelamento, 3 concorrências, reaplicação, rollback) | exit 0 | — |
| Auditoria (trilha de exceções/períodos, sem JWT, imutável para service_role) | OK | — |
| Desempenho (60 mil lançamentos/mês) | função ~160 ms; fechamento ~270–480 ms | — |
\* conhecidas da `main`: "distribuições recompõem mês…" e `selecionarPerfil (Fase C)` ×2 — fora do Financeiro. \** `dashboard-executivo-periodo-misto` e `modelo-logistico-temporal` caíram uma vez com *access violation* do Node no Windows (`0xC0000005`); passam 3/3 isolados; arquivos não tocados pelo Financeiro; o primeiro já estava catalogado como intermitente.

## 4. Integração com a `main` — **PRONTO COM RESTRIÇÃO**
Branch local **`integracao/financeiro-com-main`** @ `9d24d88` (worktree `C:\Users\ponte\OneDrive\Desktop\crescer-financeiro-com-main`), criada da trilha financeira + `merge --no-ff origin/main`. Quatro conflitos resolvidos por **união** (doc 16): `routes.js` (Checklist da main + rota financeira com gate próprio), `modulos.js` (Financeiro 17, Checklist 18), duas listas de migrations (120/121 + 123–125). Todas as suítes da tabela acima passaram. **Não** houve merge na `main` nem push. Restrição: a `main` pode andar de novo — refazer o ensaio antes de abrir PR. (Para rodar testes nessa worktree é preciso ligar `backend/node_modules` e `gateway-whatsapp/node_modules` por junction e removê-las com `cmd /c rmdir` antes de apagar a worktree.)

## 5. Migrations — **PRONTO COM RESTRIÇÃO**
`origin/main`: 110, 112–119, 123 (Checklist), 124–125 (iFood). **120–122 livres** (a própria main as reserva). 120 e 121 em `database/migrations/`; 122 em `proposta-122/` (não promovida; os arquivos `122b_*` são obsoletos). Ordem com a 123 provada nos dois sentidos. Rollbacks: recusam com dados; íntegros sem dados. Falta: T3 e a promoção da 122 (`begin/commit`, `lock_timeout`, pós-condição) — autorização à parte.

## 6. Pronto para homologação (ambiente de teste)
Telas e jornada completa; permissões por nível; relatórios/exportações; importação; fechamento sem pendências; cancelamento de transferências; integração com a `main` em branch separada; roteiro T3 (doc 14) com travas verificadas.

## 7. Depende do Supabase descartável (T3) — **BLOQUEADO até autorização**
Papéis reais (`service_role` BYPASSRLS, dono real das funções), exposição pela API pública (PostgREST/GraphQL/Realtime), F-3/F-4 com o PostgREST real (o local usa um cliente compatível com teto de 1000 linhas), concorrência e desempenho no servidor real, **MFA com TOTP real (`amr.timestamp`)**, auditoria e rollback no projeto real. Scripts prontos e verificados: nenhum lê `backend/.env`; todos exigem confirmação explícita de ambiente descartável; nenhum aplica migration fora da conexão informada.

## 8. Pode ficar desabilitado na primeira versão
- Exceção de fechamento com pendências (SuperAdmin + MFA) — **desabilitada**; meses com pendências simplesmente não fecham até serem resolvidas.
- Reabertura de período — **desabilitada** (decisão).
- Endpoint de plataforma da exceção — não implementado.
- Habilitação automática do módulo — o módulo nasce **desabilitado** em todas as empresas/unidades.

## 9. Bloqueios reais para publicação — **BLOQUEADO**
1. **T3 não executado** (precisa do projeto descartável autorizado por você).
2. **Concessão de acesso**: o acesso exige concessão explícita por perfil; a tela de SuperAdmin só funciona com `FINANCEIRO_CONCESSOES_HABILITADAS` **e** MFA recente comprovado. Sem T3/MFA, ninguém recebe acesso pela interface. **Decisão sua**: liberar a tela de concessões após o T3 (recomendado) ou definir um procedimento operacional alternativo e auditado para as primeiras concessões.
3. **Promoção da 122** e **merge na `main`** — autorizações separadas.
4. **Revisão independente ausente** — risco residual registrado (toda a auditoria é do mesmo agente); não declaro a segurança comprovada.

## 10. Commits desta missão
`cf578e9` (paginação F-4, F-3/F-4 locais, jornada E2E, travas) · `9d24d88` (merge local com a `main`, em `integracao/financeiro-com-main`) · este documento. Anteriores: `12204c2`, `1d7bcfc`, `6cb2305`, `f2b1a40`, `c963bce` e os da integração (doc 15).

## Riscos residuais
Revisão independente ausente; T3 não executado; regra de conciliação duplicada em JS e SQL (paridade obrigatória a cada mudança); limite de 1000 linhas por requisição em listagens não usadas no cálculo (plano de contas, contas, aberturas — volumes pequenos); visão ao vivo de mês fechado reflete exceções de sangria atuais (snapshot imutável); travas por flag local não defendem SQL bruto de `service_role`; testes intermitentes do Node no Windows fora do Financeiro.
