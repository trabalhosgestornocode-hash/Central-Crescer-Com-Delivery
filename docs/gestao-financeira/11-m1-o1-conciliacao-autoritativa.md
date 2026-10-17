# 11 — M1 (conciliação autoritativa no banco) e O-1 (assinaturas obsoletas) — implementação do Agente 1

Data: 2026-10-17 · Base: `integracao/gestao-financeira` @ `c963bce` (contém `cd35699` do Agente 2). Responsabilidade **temporariamente assumida pelo Agente 1** por autorização do usuário (LD-013), porque o Agente 2 estava indisponível. Nada publicado; sem migration remota; concessões desligadas; a 122 **continua em `proposta-122/`**.

## 0. Rótulos (nenhum item está aprovado)
| Item | Estado |
|---|---|
| Função `fin_conciliacao_pendencias_ids` (M1) | **IMPLEMENTADO · TESTADO LOCALMENTE · AGUARDANDO REVISÃO INDEPENDENTE** |
| `fin_fechar_periodo` / `fin_conceder_excecao_fechamento` usando o conjunto do banco | **IMPLEMENTADO · TESTADO LOCALMENTE · AGUARDANDO REVISÃO INDEPENDENTE** |
| O-1 (`drop function if exists` das assinaturas antigas + pós-condição) | **IMPLEMENTADO · TESTADO LOCALMENTE · AGUARDANDO REVISÃO INDEPENDENTE** |
| Harness de paridade, adversariais, ajustes de teste do Agente 2 | **IMPLEMENTADO · TESTADO LOCALMENTE · AGUARDANDO REVISÃO INDEPENDENTE** |
| Qualquer coisa disto no Supabase | **NÃO FEITO** (T3) |
| **APROVADO PARA T3** | **NADA ainda.** Quem implementou não se aprova (regra do usuário). LD-011/LD-012 **não** estão VALIDADAS. |

## 1. Diagnóstico da falha R-1
`fin_fechar_periodo` recebia da aplicação a lista de ids das pendências de conciliação e **confiava nela** (só validava formato e comparava com a exceção). A conciliação (`conciliar()`) é calculada em JS; o banco só conferia as *entradas* (impressão digital), não o *resultado derivado*. Uma lista vazia/incompleta (bug ou backend comprometido) fechava o mês **sem exceção** e sem pendência declarada. Prova original: venda R$ 1.000 + taxa R$ 100 sem recebimento ⇒ `ponte_mensal:AAAA-MM-01` aberta no motor; `fin_fechar_periodo(..., '{}', ...)` fechou. (Venda sozinha é `sem_referencia`, **não** pendência.) Os próprios testes SQL do Agente 2 (4a, 4f2, 4k) aceitavam ids **fabricados** — o defeito estava codificado nos testes.

## 2. Solução implementada (`docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql`)
### 2.1 `fin_conciliacao_pendencias_ids(p_org uuid, p_unidade uuid, p_mes date) returns text[]`
- `LANGUAGE sql STABLE`, **sem escrita**, `SET search_path = public, pg_temp`, **invoker**. EXECUTE: **só `service_role`** (revogado de public/anon/authenticated; a pós-condição da 122 aborta se isso mudar).
- Usa **somente dados persistidos**: `fin_lancamentos` (status `realizado`, sem categoria de papel `saldo_anterior`), `fin_plano_contas` (papel), `fin_contas` (tipo, mesma org/unidade), `fin_referencias` (status `ativa`, no mês), `fin_conciliacao_resolucoes` (status `vigente`, chave no mês), `fin_sangria_excecoes` (ativas). Escopo por organização + unidade + competência.
- Regra idêntica a `conciliar()`: **ponte mensal** só existe com venda **e** taxa informadas (senão `sem_referencia`, nunca zero); **caixa por dia** (receita líquida em `caixa_fisico` × referência `dinheiro`); **sangria por dia** (saídas de `caixa_fisico`, sem categorias com exceção ativa × referência `sangria`). Ausência de referência ≠ zero. Aberto = diferença ≠ 0 e (sem resolução, ou soma das resoluções ≠ diferença). Ids: `ponte_mensal:AAAA-MM-01`, `caixa_dia:AAAA-MM-DD`, `sangria_dia:AAAA-MM-DD`, ordenados em collation `C`.
- Agregação por dia numa passada (1,5 s → 0,15 s com 60 mil lançamentos).
### 2.2 `fin_fechar_periodo` (assinatura inalterada: `p_pendencias_conciliacao_ids text[]`)
Ordem: lock do período → versão → impressão digital → **conjunto do banco** `v_conc` → **conferência**: a lista da aplicação (ordenada) tem de ser **igual** a `v_conc` (omitida, incompleta, extra, repetida ou com nulo ⇒ `fin_conciliacao_divergente`, SQLSTATE 23514) → total de pendências = lançamentos + `v_conc` → sem pendência: fecha; com pendência: exige exceção ativa e vigente, reconhecimento explícito, **cobertura**: pendências de lançamento por id+motivos e `v_conc <@ ex.pendencias_conciliacao_ids` (subconjunto) → consome a exceção (uso único) → fecha, tudo na mesma transação, sob a trava do período. O snapshot guarda `pendenciasNoFechamento`, `pendenciasConciliacaoIds` (os do banco), `fingerprint`, `excecaoFechamentoId`. Agora com `SET search_path = public, pg_temp`.
### 2.3 `fin_conceder_excecao_fechamento` (assinatura inalterada)
O conjunto **registrado** é o do banco; a lista recebida é só conferência (divergente ⇒ `fin_conciliacao_divergente`) e **nunca** vira evidência de cobertura. Mantidos: SuperAdmin, justificativa ≥ 20, MFA AAL2 ≤ 10 min, validade ≤ 30 dias, uso único, auditoria, pendências identificadas, sem EXECUTE para o `service_role`.
### 2.4 O-1
Início da 122: `drop function if exists fin_fechar_periodo(uuid,uuid,uuid,date,integer,text,jsonb,integer,boolean)` e `fin_conceder_excecao_fechamento(uuid,uuid,uuid,date,text,integer,integer,jsonb)`. Pós-condição: aborta se existir **qualquer** sobrecarga dessas duas funções além da vigente. `122_rollback` remove a função nova e as duas antigas (bancos vindos de rascunhos). Nenhuma função da 120/121 ou de outros módulos é tocada.
### 2.5 Domínio (JS), na minha branch
`repositorio.util.js`: `FIN_CONCILIACAO_DIVERGENTE` → **409** com mensagem amigável (recarregar o pré-fechamento). A aplicação continua enviando os ids que calculou (agora só conferência).

## 3. Arquivos alterados
`docs/gestao-financeira/proposta-122/122_conciliacao_periodos.provisorio.sql`, `122_rollback.provisorio.sql`; `backend/src/modules/gestao-financeira/dominio/repositorio.util.js`; testes: `backend/testes-financeiro-pg/20_periodos_conciliacao.test.sql` (4a, 4f2, 4k reescritos para cenários **reais**; expectativas de segurança não afrouxadas — o que mudou foi o contrato: ids fabricados agora são recusados), `backend/test/financeiro/conciliacaoAutoritativa.test.js` (novo), `backend/testes-seguros/pg/{parity_m1.mjs, adversarial122.sql, adversarial122_complemento.sql, adversarial122_concorrencia.sh}`, `backend/testes-seguros/t3/amr_probe.mjs`, docs 10/11 e checklist T3.

## 4. Evidências (PostgreSQL 17 local descartável; 120 e 121 inalteradas; privilégios estilo Supabase)
| Critério LD-012 | Evidência |
|---|---|
| 1. Função calcula corretamente | Paridade JS×SQL **426/426 em duas sementes (7 e 2026)**, ~80–85 % dos cenários com pendência aberta no oráculo: 26 cenários de borda determinísticos + 200 aleatórios + 200 "apertados" (diferença zero, resoluções exatas/parciais/revogadas, exceções de sangria, previsto/cancelado, saldo anterior, referência cancelada, taxa 0 ≠ ausente) |
| 1b. O harness detecta desvios | **Mutação**: 10 defeitos deliberados no SQL (previsto/cancelado contam, ignora exceção de sangria, resolução revogada conta, referência cancelada conta, saldo anterior entra, caixa em qualquer conta, parcial = resolvida, diferença negativa ignorada, sem referência vira zero, taxa ausente vira zero) — **10/10 detectados** (a 1ª versão do harness deixava 4 passarem; foi reforçada) |
| 2. Fechamento usa o banco | `adversarial122.sql` S11: lista omitida / fabricada / extra / repetida / com nulo ⇒ `fin_conciliacao_divergente`; lista correta sem exceção ⇒ `fin_periodo_pendencias`; mês segue `aberto` |
| 3. Concessão registra o conjunto autoritativo | S11j–m: omitida/fabricada recusadas; correta registra `{ponte_mensal:…}` calculado pelo banco; exceção ativa + lista omitida ainda recusada; com lista correta + reconhecimento fecha e consome 1× |
| 4. Privilégios | simulação Supabase **sem falhas**; `service_role` executa; `anon`/`authenticated` não; STABLE, invoker, `search_path` fixo; pós-condição |
| 6. O-1 | 4 estados (banco novo; vindo de `7913b11`; vindo de `cd35699`; 122 aplicada 2×): **uma** assinatura por função, nenhuma sobrecarga `fin_*` restante |
| 7. Reprodução adversarial de R-1 | S11b/c bloqueadas (era PASS-do-defeito; agora recusa) |
| 8. Desempenho | **60 mil lançamentos** no mês: função **~155 ms** (antes da otimização ~1,5 s); `fin_fingerprint_periodo` ~120 ms; `fin_fechar_periodo` completo (mês limpo, com M1) **~227 ms** |
| Ciclo | 120→121→122→122→rollback 122→reaplica→rollback 122→121→120→reaplica: OK; rollback com dados recusa e não remove; rollback a partir do estado "vindo de rascunho" OK; 0 funções `fin_*` restantes após rollback total |
| Suíte do Agente 2 | `run.sh` (10/20/25, concorrência de fechamento, cancelamento e exceção, reaplicação com dados, rollback): **exit 0** |
| Adversariais | `adversarial122.sql` **70 PASS / 0 FALHA**; complemento **5 PASS**; corrida de 3 sessões (fecha ×2 e lançamento novo) OK; **referência de conciliação nova durante o fechamento** espera a trava e é recusada (`fin_periodo_fechado`), 0 linhas gravadas |
| Regressão | domínio+fundação **235/235**; backend T1 5386 ok / 3 falhas conhecidas / 0 violações; frontend 1530 ok / 0 falhas |

## 5. Riscos residuais (classificação do Agente 1 — a confirmar na revisão independente)
- **RR-1 (média→baixa após M1) deriva da regra duplicada.** A regra existe em JS **e** SQL. Mitigação: `parity_m1.mjs` (e a mutação) — **precisa entrar na rotina de homologação/CI com PostgreSQL**; uma mudança em `conciliacao.js` sem espelho no SQL passa a **bloquear fechamentos** (falha fechada, visível como 409), não a fechar errado.
- **RR-2 (baixa)** `fin_sangria_excecoes` não está sob a trava do período nem na impressão digital: ativar/desativar uma exceção entre a pré-visualização e o fechamento causa divergência (409, falha fechada). Entre o cálculo do banco e o commit pode haver mudança concorrente da exceção (READ COMMITTED): efeito limitado a um mês que será imutável.
- **RR-3 (baixa)** `fin_abrir_periodo`, `fin_fingerprint_periodo`, `fin_reabrir_periodo` continuam invoker sem `search_path` fixo (pré-existente). Só relevante para quem já controla o `service_role`.
- **RR-4 (baixa)** limite de 5 000 linhas por consulta na aplicação (PostgREST): com meses maiores, a lista da aplicação pode divergir do banco ⇒ 409 (fechamento bloqueado até tratar), nunca fecha errado.
- **RR-5 (informativo)** travas por flag local de transação (reabertura/fechamento/consumo) não defendem SQL bruto de quem já é `service_role`.
- **RR-6 (informativo)** desempenho medido localmente (60 mil/mês); repetir no Supabase real (T3) e com `EXPLAIN` se o volume crescer.

## 6. O que o Agente 2 deve revisar quando voltar (sem refazer)
1. O SQL de `fin_conciliacao_pendencias_ids` contra a sua intenção de `conciliar()` (principalmente: `receita_operacional` na ponte e no caixa; saída de caixa com categoria nula; `status` de lançamento; dia de `fin_conciliacao_resolucoes.chave`).
2. As reescritas de 4a/4f2/4k em `20_periodos_conciliacao.test.sql` (expectativas agora com cenário real; nenhuma foi relaxada).
3. A decisão de **igualdade** (e não subconjunto) entre lista da aplicação e conjunto do banco no **fechamento** — a cobertura da exceção continua sendo subconjunto.
4. O mapeamento 409 e a mensagem ao usuário; e se a tela deve oferecer "recarregar" no caso.
5. `repoMemoria.js` não replica a conferência do banco (a prova é em SQL): decidir se quer espelhar.

## 7. Próximos passos para o T3
Revisão independente (Agente 2 ou outro revisor) → "APROVADO PARA T3" → no Supabase **descartável**: aplicar 120→121→122 com papéis reais, repetir `adversarial122*`, `parity_m1.mjs` e a medição de desempenho; `amr_probe.mjs` com TOTP real; só então promover a 122 como migration (`begin/commit`, `lock_timeout`, pós-condição). Atenção: o stream **Checklist universal + tempos** também reserva "migration 121" — **conflito de numeração** com 120/121/122 do Financeiro; quem for para a main depois renumera.
