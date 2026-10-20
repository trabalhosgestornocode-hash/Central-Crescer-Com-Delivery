# Integração A8 — B7 (conciliação), B8 (fechamento), cancelamento atômico e revisão da 122

Branch local `integracao/gestao-financeira` (nada publicado; sem push, PR, merge na `main`, deploy, migration remota nem acesso real).

## 1. Hashes
| Item | Commit |
|---|---|
| Base (`origin/main`) | `8d32196` |
| HEAD anterior da integração (A7.1) | `5ab87e5` |
| Agente 2 — ponta verificada no momento da integração | **`6a5c59f`** (worktree dele limpo; conferido por `git rev-parse` antes de mesclar) |
| Merge A8 (história preservada) | `b840c1b` |
| Correção da 120, proposta 122b, testes HTTP A8, provas PG | `0e50c08` |
| Documentação/checklist/QA A8 | último commit desta branch (`git log -1`) |
Commits do Agente 2 incorporados: `4f04530` `96717ea` `8fa31f4` `25412eb` `110ffcc` `2159b6e` `68ec133` `b011dc8` `6a5c59f`. As branches originais seguem intactas; a worktree do Agente 2 não foi tocada.

## 2. Conflito em `backend/testes-financeiro-pg/run.sh`
Único conflito. Foi inspecionado o conteúdo real: ficou a versão do Agente 2 (aceita as duas organizações do repositório), **com uma correção**: a etapa "banco vazio" chamava `docs/…/sql-provisorio/121_rollback.provisorio.sql` (inexistente na integração, onde a 121 vive em `database/migrations`) em vez da variável `$R121` que a própria versão dele já resolvia. As travas de segurança (só loopback, `FIN_PG_DESCARTAVEL=1`) foram mantidas. Resultado: a suíte inteira passa na integração.

## 3. Contratos confirmados
`{data}` ✔ · `req.financeiro` ✔ · `autorizarAcaoFinanceira` (parâmetro do domínio: `autorizar`) ✔ · `gestao_financeira.cancelar` ✔ · `gestao_financeira.fechar` (nível gestor; rotas `periodos/abrir` e `periodos/:mes/fechar`) ✔ · `gestao_financeira.reabrir` (nenhum nível) ✔ · `render(container, ctx)` ✔ · nenhum helper com bypass de impersonação (teste estrutural) ✔. O gate NÃO foi enfraquecido: o teste estrutural enumera todas as rotas reais (agora com as de B7/B8) e exige 403 sem concessão e 403 em escrita com concessão de leitura.

## 4. Migrations
| Migration | Onde | Estado |
|---|---|---|
| 120 fundação/concessões (Agente 1) | `database/migrations/` | **corrigida no A8** (ver §4.1) |
| 121 domínio `fin_*` (Agente 2) | `database/migrations/` | **aprovada SOMENTE em conjunto com a 122** (§4.3) |
| 122 conciliação, períodos, cancelamento de par (Agente 2) | `docs/gestao-financeira/proposta-122/` (**não promovida**) | revisada; **aprovada com 2 ressalvas** (§4.2) |
| 122b endurecimento (integrador) | `proposta-122/122b_*` (**proposta, não migration**) | testada; a decidir pelo Agente 2 |
Ordem: 120 → 121 → 122 (→ 122b). Rollback: 122 → (reaplicar 121) → 121 → 120. **A 122 não foi movida para `database/migrations`**: o código do Agente 2 depende dela (colunas `revisao_motivos`, `canal_referencia`, `versao`), mas a promoção só deve ocorrer depois da decisão sobre F-A/F-B, para não gerar divergência com o arquivo que o dono edita.

### 4.1 Defeitos encontrados na MINHA 120 (corrigidos; nunca aplicada fora do banco local)
A simulação com *default privileges* do Supabase mostrou: (i) `service_role` mantinha DELETE/TRUNCATE/REFERENCES/TRIGGER em `gestao_financeira_concessoes` e na auditoria; (ii) a sequência `gestao_financeira_concessoes_auditoria_id_seq` ficava utilizável por `anon`/`authenticated`; (iii) um `grant … on all sequences in schema public to service_role` amplo demais. Correção: revogar tudo antes de conceder o mínimo, revogar a sequência, conceder só a sequência da trilha, revogar EXECUTE dos gatilhos, e estender a pós-condição. Nenhum desses furos existia no teste anterior porque ele não reproduzia os *default privileges*. As 121/122 já revogavam `service_role` antes de conceder e passaram.

### 4.2 Resultado da revisão da 122 (checklist do pedido)
| Item | Resultado | Evidência |
|---|---|---|
| Existência/posição | existe; posição correta = 122 (após a 121); fora de `database/migrations` por decisão do Agente 2 | `proposta-122/` |
| Dependências 120/121 | sem dependência da 120; exige a 121 (tabelas `fin_*`); aplica em qualquer ordem entre 120 e 121 | ciclo SQL |
| FK de `importacao_id` | existe, mas **só por id** (aceita importação de outro tenant): **F-B (baixa)** | sondagem E1 |
| Bloqueio de mês fechado | **OK** em lançamentos (insert/update/mover de/para mês fechado), referências, resoluções, saldos de abertura, snapshot imutável, refechar | sondagens C1–C9 |
| Integridade das transferências | **OK**: R5 corrigido (categoria/valor/conta/data/sentido de perna vinculada), cancelamento parcial impossível mesmo com flag forjada (rede no COMMIT), par cancelado imutável, DELETE negado | sondagens G1–G10 |
| Sequência da auditoria | **OK** (122 revoga de anon/authenticated); a da 120 corrigida | simulação |
| Idempotência | **OK** (2×, e 121 reaplicada depois da 122) | ciclo + `run.sh` |
| Rollback | **OK com ressalva**: o rollback da 122 deixa escritas falhando até reaplicar a 121 (**F-C, baixa/operacional**); o da 121 recusa com qualquer linha, inclusive as `aberto` auto-criadas | ciclo SQL |
| Concorrência | **OK** (duas sessões reais: fechamento × escrita; cancelar × cancelar/desvincular/editar) | `30_concorrencia.sh` na integração |
| RLS / revokes / `service_role` | **OK**: RLS ligado, zero policies, anon/authenticated sem nenhum privilégio, `service_role` sem DELETE/TRUNCATE, sem INSERT em `fin_auditoria` | simulação (37+ verificações) |
| Proprietários / `SECURITY DEFINER` | **OK**: 3 funções DEFINER (`fin_auditar`, `fin_desvincular_transferencia`, `fin_desvincular_transferencia_motivada`), todas com `search_path = public, pg_temp`; dono não-superusuário e sem BYPASSRLS funciona | simulação |
| `FORCE RLS` | **não adotar** nas `fin_*` (os gatilhos DEFINER dependem do dono não ser filtrado). Segurança comprovada **sem** FORCE: anon/authenticated não têm privilégio algum; só `service_role` (backend) tem acesso | simulação + experimento do Agente 2 |
| **Reabertura** | **F-A (MÉDIA, alcançável só por quem tem SQL como service_role/backend comprometido)**: `service_role` reabre mês fechado por `UPDATE` direto e executa `fin_reabrir_periodo`, apesar de a política ser "reabertura desabilitada" (hoje só o serviço do backend falha fechado) | sondagem D1/D2 |
**Veredito da 122: APROVADA COM CORREÇÕES — F-A deve ser decidida antes de qualquer homologação; F-B/F-C não bloqueiam.** A proposta **122b** fecha F-A e F-B sem alterar a 122 (testada: D1 bloqueado, D2 "permission denied", E1 violação de FK, e todos os fluxos legítimos continuam; rollback/reaplicação OK). Limite honesto da 122b: a trava usa flag local de transação; defende o backend/API, **não** quem já tem SQL bruto como `service_role`.

### 4.3 Situação definitiva da 121
Corpo idêntico ao provisório do Agente 2 (diff verificado). **A 121 sozinha tem a falha R5** (perna vinculada trocava de categoria) e a FK de importação sem escopo; as correções vivem na 122. **Regra: nunca aplicar a 121 sem a 122.** O sinal "aprovada" do Agente 2 é condicionado; o meu é o mesmo. Não há dependência de recursos específicos do Supabase para a 121 **além dos listados em §6**.

## 5. Cancelamento atômico, B7 e B8 — o que foi verificado
Teste HTTP com o gate real e o domínio real (`test/gestao-financeira-a8-integrado.test.js`, 27 testes) + banco real (sondagens) + navegador real.
| Exigência | Resultado |
|---|---|
| Exige `gestao_financeira.cancelar` | leitura/operador → 403 `FINANCEIRO_PERMISSAO_INSUFICIENTE`, par intacto |
| Empresa e unidade verificadas | par de outra unidade/empresa → não encontrado; concessão de outra empresa → 403 |
| Motivo obrigatório | ausente/vazio/<10 → 400, nada muda |
| Duas pernas + par na mesma transação; sem cancelamento parcial | HTTP: ambas mudam juntas; banco: perna isolada recusada, flag forjada barrada no COMMIT |
| Período fechado em qualquer perna | recusado e nada muda (HTTP e banco) |
| Auditoria preservada | 3 linhas (2 pernas + par) com antes/depois |
| Idempotente | repetir → `jaCancelada`, sem nova auditoria |
| Concorrência | HTTP (2 cancelamentos; cancelar × desvincular → nunca estado misto) e banco (duas sessões reais) |
| Impersonação | 403 `FINANCEIRO_BLOQUEADO_IMPERSONACAO` |
| Sem exclusão física | nenhuma rota DELETE; `service_role` sem DELETE; contagem de lançamentos inalterada |
**B7 conciliação:** sem referência → `sem_referencia` (nunca zero/nem pendência inventada); referência de canal **só** casa com conta com vínculo EXPLÍCITO conta↔canal (nunca por nome); com venda+taxa e diferença → `pendente_identificacao` e **nenhuma** resolução automática ("prazo" só por classificação manual, com nota); valor 0 informado ≠ ausência. A planilha complementar real **não foi fornecida e não foi usada**: a conciliação definitiva depende dela (ou fonte equivalente).
**B8 fechamento:** pré-fechamento com impressão digital + versão; fechar exige `confirmo`; mudança de dados entre prévia e confirmação → **409** `FIN_PERIODO_CONFLITO_DADOS`; versão desatualizada → 409 `…_VERSAO`; pendências bloqueiam (política padrão) e reconhecer sem política aprovada não basta; mês fechado bloqueia lançamento/edição/referência; snapshot imutável; fechamento auditado. **Reabertura desabilitada:** nenhum nível a concede (403), o serviço também falha fechado (`REABERTURA_NAO_HABILITADA`); a UI mostra o texto explicativo e **nenhum botão** "Reabrir". Política futura (permissão separada `reabrir`, MFA AAL2 recente, motivo, snapshots preservados, supervisão) **não foi implementada** — sem bypass.
**Decisão pendente (registrada na Ligação Direta):** `PUT /periodos/politica` (permitir fechar com pendências) exige só `configurar` (gestor). Mudar a política de fechamento talvez devesse exigir permissão mais restrita.

## 6. Dependências do Supabase que NÃO foram provadas (bloqueantes para T3)
Atributos reais dos papéis (`service_role` BYPASSRLS — a 120 usa `FORCE RLS` e depende disso), dono real das tabelas/funções e se tem BYPASSRLS, *default privileges* reais do projeto, PostgREST/pg_graphql/Realtime e advisors. Tudo isso foi **simulado** localmente; qualquer divergência no Supabase real é bloqueante. Checklist atualizado em `05-checklist-homologacao-t3-mfa.md`.

## 7. Testes (T1, ambiente fictício; `npm test` antigo NÃO usado)
| Suíte | Resultado |
|---|---|
| Backend completo | 5405 testes · 5377 ok · 3 falhas conhecidas · 25 pulados · **0 violações de isolamento** |
| Frontend completo | 1538 · 1527 ok · 0 falhas · 11 pulados |
| Testes do domínio (Agente 2) + autorização + estruturais + HTTP integrados | todos ok |
| HTTP A8 (gate + domínio reais) | 27/27 |
| Navegador real do Agente 2 (Chrome, desktop/celular/escuro) | 14/14 |
| QA visual integrado (12 páginas, mobile, escuro, níveis, estados) | 56/56 |
| PostgreSQL descartável: 120→121→122 + `run.sh` (domínio, períodos, cancelamento, concorrência, rollbacks) | OK |
| Simulação de privilégios estilo Supabase | sem falhas (com e sem a 122b) |
**Falhas conhecidas (idênticas às da `main`, já classificadas em `04-…`):** Novos Clientes (pendência de negócio da Central de Performance, intocada) e `selecionarPerfil` ×2 (precisa de Supabase real → T3). Nenhuma regressão nova.

## 8. Funcionalidades
**Concluídas (local):** Visão Geral, Fluxo de Caixa, Contas (com cancelar/desvincular transferência), DRE, Indicadores, Categorias, Plano de Contas, Importação, **Conciliação (B7), Períodos (B8)**. **"Em construção" (B9):** Relatórios, Configurações Financeiras.

## 9. Riscos residuais
F-A aberto até decisão do Agente 2 (a 122b o fecha) · 122 não promovida (código depende dela; aplicar 121 e 122 sempre juntas) · rollback da 122 com janela de falha · política de pendências alterável por gestor · conciliação sem a planilha complementar (nada validado como definitivo) · tudo provado só em memória e em PostgreSQL local descartável · T3/MFA não feitos · regime de caixa precisa de validação do dono do negócio · isolamento do T1 é em processo (não é sandbox de SO).

## 10. Checklist para incorporar o B9 (Relatórios, Configurações, exportações)
- [ ] Ler `02-AGENTE-2-PARA-1.md` e conferir a ponta REAL da branch dele (não presumir hash).
- [ ] Merge com `--no-ff` em worktree/branch exclusiva; resolver conflitos lendo o conteúdo (não aceitar versão por conveniência).
- [ ] Novas rotas entram sozinhas no teste estrutural; exportações (CSV/XLSX/PDF) exigem `ver` (leitura) e **não** podem vazar outra unidade; limites de corpo/uploads no `app.js` (pendência §1 do contrato).
- [ ] Nova migration (123+): revisão equivalente (privilégios com *default privileges*, sequências, DEFINER, rollback, concorrência); decisão sobre 122b.
- [ ] `Configurações Financeiras` não pode reabrir período nem alterar a política de pendências sem a permissão decidida.
- [ ] Rodar T1 completo, HTTP A8, QA visual e a simulação de privilégios; atualizar a Ligação Direta e este documento.
