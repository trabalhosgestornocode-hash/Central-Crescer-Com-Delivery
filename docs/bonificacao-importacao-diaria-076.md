# Importação diária da Bonificação — integridade de vínculo (migration 076)

Corrige o defeito que produziu os indicadores errados de setembro/2026 na Subway Saci — Matriz
(01–04/09 persistidos como `0109 + 0209 + 0409 + 0409` = 494/200/82/69 → 40,5 / 16,6 / 14,0,
em vez de `0109 + 0209 + 0309 + 0409` = 475/199/99/77 → 41,9 / 20,8 / 16,2).

**Escopo:** exclusivamente o fluxo de importação/vínculo DIÁRIO. Não toca `bonificacao_competencia`,
snapshot, migration 075, fechamento mensal, `obterMes()`, nem corrige dado legado.

---

## Causa

O fluxo antigo (`processarImportacaoVisio`) permitia:

- reaproveitar uma `bonificacao_importacoes` de **outro dia** (o `uq_bimp_hash` forçava reuso do
  único registro do hash; o serviço vinculava-o a um segundo dia);
- `substituir` devolvia o `importacao_*_id` anterior **sem validar data/período**;
- o mesmo documento/hash alimentava **dois dias** da mesma competência;
- a ausência de um relatório diário era mascarada pelo relatório de outro dia;
- nenhuma verificação de **período do documento** vs **dia do lançamento**.

O parser de quantidades e a fórmula mensal (`mixMensalPonderado`) **não foram alterados**.

## O que a correção faz

### Camada de serviço — `backend/src/modules/bonificacao-mensal/bonificacaoMensal.importacao.js`

| Função | Papel |
|---|---|
| `extrairPeriodoDiario(texto)` | Período **só** de rótulo explícito (`Período:` / `Data de venda:` + `dd/mm/aaaa [a dd/mm/aaaa]`). Datas de geração e eixos de gráfico não contam. Períodos conflitantes no mesmo doc → erro. |
| `resolverPeriodoDiario({ data, persistido, extraido, declarado, nomeArquivo })` | Precedência: **registro anterior → conteúdo do PDF → confirmação explícita do usuário**. Nome do arquivo = só sinal auxiliar (bloqueia se contradiz o dia, nunca fornece o período sozinho). Período ≠ dia → erro. Sem conteúdo e sem confirmação → erro. |
| `validarVinculoImportacao(imp, alvo, vinculos)` | Antes de reutilizar uma importação: confere organização, unidade, tipo, competência (AAAA-MM), `data_lancamento == dia`, período == dia, e que **nenhum outro lançamento** (unidade, data) já use o mesmo id. |
| `conferirImportacao` / `localizarImportacao` / `prepararImportacaoDiaria` / `registrarImportacaoDiaria` | Localização por **hash** (nunca por nome), com re-leitura em caso de colisão `UNIQUE` (concorrência). |

`processarImportacaoVisio` monta `alvo {organizacaoId, unidadeId, tipo, data}`, chama
`prepararImportacaoDiaria` na prévia e `registrarImportacaoDiaria` na persistência, e **revalida a
importação preservada** do slot que não veio no upload (um upload parcial não perpetua vínculo inválido).

### Regra de `substituir`

| Situação | Comportamento |
|---|---|
| Mesmo dia/período, mesmo hash | Reusa o id (idempotente); nova prévia lado a lado; auditoria preservada. |
| Mesmo dia, hash diferente (reupload corrigido) | Nova importação `substituiu_importacao_id = <anterior>`; re-vincula; audita a troca. |
| **Dia/período diferente** | **Bloqueado** — "A importação já pertence a `<data>` e não pode ser reutilizada em `<data2>`, mesmo com substituir." Nada é movido/reaproveitado. |

### Migration 076 — `database/migrations/076_bonificacao_importacao_diaria_integridade.sql`

Defesa em profundidade no banco (`security definer`, `revoke all from public`):

- Colunas `periodo_inicio` / `periodo_fim` / `periodo_fonte` em `bonificacao_importacoes` (nullable — legado tolerado).
- `trg_bonificacao_documento_diario` (BEFORE INSERT/UPDATE em `bonificacao_importacoes`):
  identidade + período + `hash` + `status` **imutáveis** após criados; dedup por `(unidade, hash)`
  com `pg_advisory_xact_lock`; `status='concluida'` exige `periodo_* = data_lancamento` e
  `periodo_fonte in ('conteudo','confirmacao_usuario')`; `substituiu_importacao_id` tem que ser do
  mesmo contexto/dia.
- `trg_bonificacao_vinculos_diarios` (BEFORE INSERT/UPDATE OF org/unidade/data/importacao_* em
  `bonificacao_lancamentos_diarios`): a importação vinculada tem que casar org/unidade/tipo/status/
  data/período com o lançamento, e **ninguém mais** pode usar o mesmo id.
- `trg_bonificacao_auditar_importacao_diaria` (AFTER INSERT/UPDATE OF importacao_*): grava
  `plataforma_auditoria` (`acao = bonificacao_mensal.importacao_diaria_gravada`, catalogada em
  `shared/auditoria.js#ACOES`) na **mesma transação** — se a auditoria falhar, a alteração do
  lançamento é revertida.

**Rollback:** `database/migrations/076_rollback.sql` (dropa os 3 gatilhos/funções + as 3 colunas;
reexecutável; não toca em dado).

**Não corrige dado legado** — a anomalia de agosto/setembro continua no banco até a retificação manual.

### Frontend

`bonificacaoMensalImportModal.js` (pane diário): input "Data de venda" + checkbox de conferência
por relatório → envia `arquivo.periodo = { inicio, fim, confirmado }`.

## Testes

| Arquivo | Cobertura |
|---|---|
| `backend/test/bonificacao-importacao-diaria.test.js` | 8 testes puros (sem rede; usa `vm.SourceTextModule` → `npm test` roda com `--experimental-vm-modules`). Regras de período/vínculo + corpo real do serviço com Supabase falso. Inclui `475/199/99/77 → 41,9 / 20,8 / 16,2`. |
| `backend/test/bonificacao-importacao-postgres.test.js` | 9 testes contra Postgres descartável (`BM_IMPORT_PG_URL` ou cluster loopback :55476 + `BM_IMPORT_PG_TEST=1`). Migration idempotente preserva legado; UPDATE p/ id de outro dia recusado; falha de auditoria reverte; concorrência → 1 vence. |

---

## Retificação de setembro/2026 — RUNBOOK (não executado)

Alvo: unidade `00000000-0000-0000-0000-0000000000a1` (Subway Saci — Matriz), competência **2026-09**
(`aberta` — `bonificacao_competencia` não existe).

### Estado a corrigir

| dia | `importacao_loja_id` | loja s/b/a/d | correto? |
|---|---|---|---|
| 01/09 | `266ec400` (0109) | 108/49/20/21 | ✅ |
| 02/09 | `12a4059d` (0209) | 120/49/24/18 | ✅ |
| 03/09 | `ab0cafcc` (**"Visio 0409.pdf"**, `data_lancamento=2026-09-03`) | 133/51/19/15 | ❌ (é o dado do dia 04) |
| 04/09 | `ab0cafcc` (mesmo id) | 133/51/19/15 | dado ok, vínculo reusado |

Metades **GERAL** de todos os dias estão corretas — **não tocar**. O "Visio 0309.pdf" (loja, ≈ 114/50/36/23) nunca entrou.
`475 = 228(01–02) + 114(03) + 133(04)` · `199 = 98 + 50 + 51` · `99 = 44 + 36 + 19` · `77 = 39 + 23 + 15`.

### Decisão sobre `ab0cafcc`: **preservar, marcar `status='erro'`** (não DELETE)

`bonificacao_importacoes.status` só aceita `('concluida','erro')` — `'erro'` é válido e **factualmente
correto** (foi importação errada). Preserva hash / PDF / timestamps / usuário / storage; a nova
importação de 0409 grava `substituiu_importacao_id = ab0cafcc` (cadeia auditável). A 076 depois o
"aposenta" naturalmente (nenhum lançamento pode apontar para `status ≠ 'concluida'`).
**A marcação `erro` precisa ocorrer ANTES da 076** (a migration congela `status`).

### Ordem de execução em produção (aprovada)

1. **Pré-checks read-only** — competência `aberta`/`reaberta`; estado bate 1:1 com a tabela acima
   (`ab0cafcc.status='concluida'`, `data_lancamento='2026-09-03'`, `hash=1913fb2e72f0…`; dias 03 e
   04 apontam para ele); não existe import loja de 03/09; nenhum dia ≥ 05/09 dependente; PDFs
   "Visio 0309.pdf" e "Visio 0409.pdf" em mãos e conferidos (estabelecimento "Subway Teresina Saci",
   período, quantidades esperadas); backend + 076 prontos para subir juntos.
2. **Evidência / backup** — `SELECT` completo (JSON) de `ab0cafcc`, das 4 linhas de lançamento
   01–04/09 e das 7 importações ligadas; confirmar PDFs no Storage; `pg_dump` lógico restrito à
   unidade; registrar `plataforma_auditoria` `acao='bonificacao_mensal.retificacao_setembro_iniciada'`
   com o dump em `detalhes` (via serviço, não SQL cru).
3. **Validar 076 em staging** — aplicar `076_*.sql` no Supabase de teste; `BM_IMPORT_PG_URL` →
   `node --test test/bonificacao-importacao-postgres.test.js` (9/9); suíte backend contra staging.
4. **Ainda SEM 076 em produção** (transação única, com auditoria explícita):
   - `UPDATE bonificacao_importacoes SET status='erro' WHERE id='ab0cafcc-…' AND status='concluida';` (1 linha)
   - Soltar a metade **LOJA** do dia **03** — `importacao_loja_id=NULL` + `qtd_*_loja=NULL` +
     `faturamento_loja/ppd_loja/percentual_*_pdf=NULL` (mantém a metade GERAL). (1 linha)
   - Soltar a metade **LOJA** do dia **04** (idem — será reimportada limpa). (1 linha)
   - Registrar `plataforma_auditoria` `acao='bonificacao_mensal.retificacao_setembro_desvinculo'` (antes/depois).
   - **Validar** `Σ 01–02 (loja) = 228 / 98 / 44 / 39` inalterado; dias 03/04 com loja vazia; metades GERAL intactas.
5. **Aplicar migration 076 em produção** — depois validar: 3 gatilhos (`trg_bonificacao_*diar*`),
   3 colunas `periodo_*`, contagens de linhas legadas inalteradas, anomalia de agosto intocada.
   Se falhar → `076_rollback.sql` e abortar.
6. **Importar "Visio 0309.pdf" em 03/09** — `POST /bonificacao-mensal/importar` (preview → confirmar)
   com `{ data:"2026-09-03", loja:{ nomeArquivo:"Visio 0309.pdf", conteudoBase64:…, periodo:{ inicio:"2026-09-03", fim:"2026-09-03", confirmado:true } } }`.
   Bloqueio esperado se o PDF estiver errado (estabelecimento, nome contraditório, período) → abortar.
7. **Importar "Visio 0409.pdf" em 04/09** — idem com `data:"2026-09-04"`. `localizarImportacao` não
   acha `concluida` (o `ab0cafcc` agora é `erro`) → cria nova importação `data_lancamento='2026-09-04'`,
   `substituiu_importacao_id=ab0cafcc`. Conferir quantidades = 133/51/19/15.
8. **Validar totais**
   `SELECT sum(qtd_sanduiches_loja), sum(qtd_bebidas_loja), sum(qtd_adicionais_loja), sum(qtd_diversos_loja) FROM bonificacao_lancamentos_diarios WHERE unidade_id='…a1' AND data BETWEEN '2026-09-01' AND '2026-09-04';`
   **Esperado: 475 | 199 | 99 | 77.** Dia 03 loja = 114/50/36/23; dia 04 = 133/51/19/15.
9. **Validar percentuais** — `GET /bonificacao-mensal/mes?ano=2026&mes=9` →
   `indicadores.{bebidas,adicionais,diversos}.valorAtual ≈ 41,9 / 20,8 / 16,2` (parcial 01–04;
   recalcula sozinho — competência `aberta`).
10. **Validar auditoria** — sequência em `plataforma_auditoria`:
    `retificacao_setembro_iniciada` → `retificacao_setembro_desvinculo` →
    `bonificacao_mensal.importacao_diaria_gravada` (×2, dias 03 e 04) →
    (registrar) `retificacao_setembro_concluida` com o dump final. Append-only — nada é editado/apagado.

### Critérios de ABORTAR

Antes de qualquer escrita:
- Competência 2026-09 está `fechada` ou `legado_sem_fechamento`.
- Estado de produção ≠ tabela acima (id diferente, dia extra importado, `ab0cafcc` já modificado).
- Já existe importação `loja` com `data_lancamento='2026-09-03'`.
- PDFs "Visio 0309.pdf" / "Visio 0409.pdf" ausentes ou divergentes (estabelecimento/período/quantidades).
- Backend + 076 não passaram na suíte contra staging.

No meio (→ rollback):
- Passo 4 altera mais de 1 linha por statement, ou `Σ 01–02` muda.
- Aplicação da 076 em produção falha, ou a validação do passo 5 falha.
- Passo 6/7: o fluxo de importação devolve bloqueio (estabelecimento/período/nome/duplicidade) → PDF errado.
- Passo 8: `Σ 01–04 ≠ 475/199/99/77`.
- Passo 9: percentuais fora de `41,9 / 20,8 / 16,2` (± arredondamento).
- Alguém fecha a competência 2026-09 durante a janela (imports passam a devolver HTTP 409).
- Qualquer erro inesperado de gatilho/constraint.

### Rollback de dados

- **Passo 4 (pré-076):** `ROLLBACK` da transação; ou restaurar do dump do passo 2:
  `UPDATE bonificacao_importacoes SET status='concluida' WHERE id='ab0cafcc-…';`
  `UPDATE bonificacao_lancamentos_diarios SET importacao_loja_id='ab0cafcc-…', qtd_*_loja=<dump>, … WHERE data IN ('2026-09-03','2026-09-04');`
- **076 aplicada, passos 6/7 falharam:** `076_rollback.sql` (validado, reexecutável) → `status` volta a mutável → rollback de dado acima.
- **Import errado persistido:** `POST /bonificacao-mensal/lancamentos/:data/excluir` (`excluirLancamento` — audita com motivo + snapshot e libera a importação), depois reimportar.
- **Último recurso:** restore do `pg_dump` do passo 2, restrito à unidade.
- Linhas de `plataforma_auditoria` **não** são revertidas (append-only, proposital) — documentam a tentativa.
