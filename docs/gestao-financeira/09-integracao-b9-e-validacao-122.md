# 09 — Integração do B9 e validação formal da 122 (LD-005 / LD-006)

Data: 2026-10-17 · Branch `integracao/gestao-financeira` · Entrada: Agente 2 `7913b11` (inclui B9 `969faff`). Nada publicado (sem push, PR, merge na main, deploy ou migration remota). `FINANCEIRO_CONCESSOES_HABILITADAS` segue desligada.

## 1. O que foi validado (contra o COMMIT `7913b11`, nunca contra árvore suja)
Cluster PostgreSQL 17 descartável local (marcador `MARCADOR_DESCARTAVEL`), 120 e 121 exatamente como em `ebb355f`, privilégios estilo Supabase (dono não-superusuário, default privileges ALL, `service_role` BYPASSRLS).

| Prova | Resultado |
|---|---|
| Ciclo 120→121→122→122→rollback 122→(sem reaplicar a 121, lançamento grava)→reaplica 121→rollback 122→rollback 121→rollback 120→reaplica as três | **OK** |
| Simulação de privilégios (anon/authenticated sem acesso; `service_role` sem DELETE/TRUNCATE; DEFINER com `search_path` fixo; RLS ligada; sem policies) | **sem falhas** |
| **F-A** `service_role`: UPDATE direto reabrindo mês fechado | **barrado** (`fin_reabertura_desabilitada`); `fin_reabrir_periodo` sem EXECUTE; `fin_conceder/revogar_excecao_fechamento` sem EXECUTE; `SET session_replication_role` negado |
| **F-B** FK de importação | composta `(organizacao_id, unidade_id, importacao_id)`; nenhuma FK de coluna única restante |
| **F-C** rollback da 122 | lançamentos gravam logo após o rollback; `md5` das funções da 121 idêntico |
| Suíte do Agente 2 com concorrência real (2 sessões), reaplicação com dados, rollback recusado com dados, rollback em banco vazio | **exit 0** (`TODOS OS TESTES SQL PASSARAM`, `CONCORRENCIA OK`, `…reaplicacao…OK (12/4/3/39)`) |

### Veredito
- **LD-005 (F-A, F-B): VALIDADA** para `7913b11`.
- **LD-006 (sequência 120→121→122, rollback inverso, reaplicação, privilégios, concorrência): VALIDADA** para `7913b11`. Não há 123.
- **LD-007: NÃO validada** — ver pendências abaixo. **A 122 NÃO foi promovida a migration** e não deve ser antes de LD-007.

## 2. Achados novos (não corrigidos por mim; arquivos do Agente 2)
- **F-D (média) — fechar mês COM pendência por UPDATE direto.** Como `service_role`, `UPDATE fin_periodos SET status='fechado', fechado_por=…, fechado_em=now(), snapshot='{…}'` num mês com lançamento pendente **passa** (o gatilho só exige snapshot/responsável/data). Contorna política de pendências, exceção por competência, impressão digital e versão. `INSERT` já como `fechado` também passa. Correção sugerida (mesmo padrão da trava de reabertura): gatilho em `fin_periodos` que só aceita a transição para `fechado` (INSERT ou UPDATE) quando `current_setting('fin.fechando_periodo', true) = NEW.id::text`, flag que `fin_fechar_periodo` passa a definir **antes** do UPDATE (hoje só a define no ramo de exceção). Mesmo limite honesto da F-A: não defende SQL bruto de quem já controla o `service_role`.
- **P-1 (baixa):** `fin_mfa_evidencia_valida(jsonb)` (árvore de trabalho do Agente 2, ainda sem commit) fica executável por `anon`/`authenticated`; revogar no bloco final.
- **Decisões do usuário ainda não refletidas no commit `7913b11`:** janela de MFA **10 min** (o SQL aceita 15), evidência com lista fechada de chaves, `sessao_ref` por hash, comparação por **conjunto** de ids (conciliação hoje só por contagem — troca 1-por-1 passa), testes de corrida e de exceção vencida, rota `POST /periodos/:mes/reabrir` removida (hoje 403 fail-closed). O Agente 2 aceitou (`RE: LD-009`, 13:59) e tem trabalho não commitado; HEAD novo ainda não anunciado.

## 3. B9 integrado (relatórios, exportações, configurações)
Merge `--no-ff` de `7913b11`. Conflito único: `backend/testes-financeiro-pg/run.sh` → mantida a versão dele com o caminho `$R121` (rollback da 121 em `database/migrations/`).

Revisão de exportações (fontes + testes HTTP novos `backend/test/gestao-financeira-b9-exportacoes.test.js`, 9/9, gate REAL):
- **Autorização:** `ver` (leitura/operador/gestor exportam); sem concessão, impersonação e perfil de exibição → 403 sem nenhum byte de arquivo; catálogo e tela também passam pelo gate.
- **Isolamento por unidade:** `unidadeId` ≠ contexto → 403 `UNIDADE_FORA_DO_CONTEXTO` (tela e exportação); o conteúdo exportado nunca contém dados de outra unidade.
- **CSV/XLSX:** BOM UTF-8, separador `;`, CRLF; XLSX é zip válido; **neutralização** de `= + - @ TAB CR LF` com apóstrofo (texto original preservado); nome de arquivo por slug seguro.
- **Download:** `Content-Disposition: attachment`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Linhas`.
- **Volume:** tela 2 000 linhas; exportação até 50 000, acima recusa `EXPORTACAO_GRANDE`. É `GET` — sem corpo, portanto sem relação com os limites de `express.json`.
- **Dados parciais:** `meta.parcial/avisos` presentes; QA visual confirma que a tela não inventa números.
- **Observações para decisão do usuário (não bloqueiam):** (i) exportar exige só `ver` (o nível *leitura* extrai até 50 mil linhas); separar numa permissão `exportar` seria mudança de contrato; (ii) exportações **não geram trilha de auditoria**; (iii) 50 mil linhas montadas em memória por requisição, sem limitador de taxa próprio da rota.
- Configurações: mostra só o que o domínio realmente suporta; reabertura e regras automáticas aparecem como **indisponíveis** com motivo.

## 4. Contrato da política de pendências (LD-008) já refletido na integração
`PUT /periodos/politica`: nunca liga (403 `POLITICA_EXCEPCIONAL_DESABILITADA`), desligar é no-op (200), `GET` fixo (`permiteFecharComPendencias:false`, `excecaoFechamentoHabilitada:false`). Meu teste `gestao-financeira-a8-integrado.test.js` foi adaptado e confirma também que a reabertura por HTTP falha fechada (403/404).

## 5. Regressão após o merge
- Backend T1 (`test/*.test.js`): 5405 testes · 5377 ok · 3 falhas conhecidas (Novos Clientes; `selecionarPerfil` ×2) · 25 pulados · 0 violações de isolamento.
- Domínio + fundação (`test/financeiro/*.test.js` + `test/gestao-financeira-*.test.js`, inclui os 9 novos): **222/222**.
- Frontend: 1541 testes · 1530 ok · 0 falhas · 11 pulados (navegador).
- QA visual integrado (Chrome real, gate+domínio reais): **56/56**, 0 erros de script, com Relatórios e Configurações agora marcados como implementados.

## 6. Pendências para promover a 122 como migration
1. Agente 2 entregar o HEAD com A1–A6 (10 min, evidência fechada, conjunto de ids, corrida/vencida, rota de reabertura removida) **e** F-D e P-1.
2. Nova revisão cruzada completa (ciclo, privilégios, concorrência) no HEAD novo.
3. Só então promover `122_*.sql` com `begin/commit`, `lock_timeout` e pós-condição (como a 121).
4. T3 (Supabase descartável): comprovar que `amr[].timestamp` é o do evento TOTP efetivo, que o refresh não o renova e a unidade (segundos) — até lá o fluxo administrativo da exceção permanece bloqueado.
