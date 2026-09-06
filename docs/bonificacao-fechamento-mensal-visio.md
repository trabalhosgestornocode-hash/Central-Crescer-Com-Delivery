# Fechamento Mensal Visio — Arquitetura v3.1 (aprovada para execução em fases)

> Incorpora os **8 ajustes obrigatórios** + a **correção arquitetural do §7.3** (registrada
> em 2026-09-05, obrigatória antes da F3). **Nada implementado além do escopo da F1.**
> Sem commit / push / migration em produção / merge / deploy.
> Pré-requisito já validado e no working tree: fix de normalização numérica pt-BR
> do `visio-parser.js` (`parseNumeroBR` / `parseQuantidadeBR` / `parseMoedaBR`).

### Histórico de revisões
- **v3** — 8 ajustes obrigatórios incorporados.
- **v3.1** — §7.3 corrigido: o snapshot do fechamento **NÃO** é fabricado por `obterMes()`.
  Uma função pura `montarResultadoFechamentoOficial(...)` produz o formato canônico; a
  competência só vira `fechada` **depois** do `INSERT` do snapshot e do `COMMIT`. Mantém a
  invariante "`obterMes()` nunca lê `bonificacao_fechamento_mensal` para decidir o resultado
  de uma competência". Ver §7.3 e §14.

---

## 0. Ajustes obrigatórios incorporados

| # | Ajuste | Onde entrou |
|---|---|---|
| 1 | Sem bloco `funcionarios`. Snapshot usa `escopoBonificacao: "unidade"` + `unidade: {...}`. `confirmadoPor` → `metadados`. | §5 (snapshot) |
| 2 | Cross-check extra: `produtos_faturamento_loja` **vs** Σ `faturamento_loja` diário → **só alerta**, nunca bloqueio nem fonte de cálculo. | §6.3 |
| 3 | Histórico anterior → estado `legado_sem_fechamento` + snapshot legado imutável `origem: "legado_pre_refatoracao"`. Não é "oficial Visio". Sem fechamento retroativo obrigatório. | §4, §7, §9 |
| 4 | `migration-075.test.js`: **cenário A** (1 linha → aborta, tudo intacto) + **cenário B** (0 linhas → aplica). Produção = 0 linhas = caminho real. | §8.4 |
| 5 | `bonificacao_competencia_snapshot` **append-only de verdade**: sem `substituido_em`, sem UPDATE em versão nenhuma. Versão vigente = `bonificacao_competencia.versao_atual`. Imutabilidade **no banco** (trigger `BEFORE UPDATE/DELETE → RAISE`). | §5.2, §8.2 |
| 6 | Snapshots com `ON DELETE RESTRICT` (nunca CASCADE). Exclusão de competência com snapshots **bloqueada**. Companion: `impactoExclusaoEmpresa/Unidade` + `excluir_organizacao_definitivamente`. | §5.2, §8.3, §11 |
| 7 | Resolução de `obterMes()` chaveada por **`competencia.status`** (não por `fechamento.status`). Fechamento anterior fica só para auditoria durante reabertura. | §4, §6 |
| 8 | Regra fundamental: mês aberto → projeção; mês fechado (2 relatórios validados) → snapshot oficial; reaberto → volta a provisório; novo fechamento → nova versão. **Nunca dois números concorrentes.** | §4, §6, §7 |

---

## 1. Princípios

1. **Uma fonte oficial por indicador.** Zero "valor Central × valor Visio × diferença" na Bonificação.
2. **Fechamento = 2 relatórios oficiais** (Vendas mensal Geral + Produtos mensal Loja/Balcão). **Os dois obrigatórios para confirmar.**
3. **`bonificacao_competencia.status` é a fonte da verdade** de qual resultado vale.
4. **Segurança financeira:** `bonificacaoDefinitiva` só existe para competência `fechada`.
5. **Zero lógica duplicada.** `obterMes()` monta o resultado uma vez; todos leem dali.
6. **Snapshot imutável.** Congelado no banco, nunca alterado; reabertura gera versão nova.

---

## 2. Auditoria — o que cada relatório da Visio fornece (confirmado nos fixtures reais)

### 2.1 "Relatório de Produtos" (Loja/Balcão) — `parseVisioProductReport`

| Campo | Uso | Extraído hoje |
|---|---|---|
| Estabelecimento | validação de unidade (token) | ✅ |
| Sanduíches/Saladas · Bebidas · Adicionais · Diversos (**quantidades**, seção "% de acompanhamentos em vendas principais") | **base do Mix** | ✅ |
| 3 % que o PDF calcula (42,4 / 28,8 / 14,4) | **só validação cruzada da importação** — nunca no cálculo | ✅ |
| Faturamento (Loja) — tabela "Torque por estabelecimento" | cross-check de canal + exibição | ✅ |
| **PPD** | exibição/auditoria (decisão 4 — sem meta) | ✅ (tabela Torque) |
| **Torque líquido** | exibição/auditoria | ⚠️ **expor** (tabela tem) |
| Perdas | exibição/auditoria | ⚠️ **expor** |
| Fat. sanduíches/saladas + % do fat. total | exibição/auditoria | ❌ **adicionar** |
| "Indicadores por categoria" → Total de itens + Total R$ | exibição/auditoria | ❌ **adicionar** (só totais) |
| Combos, Top sanduíches, gráficos | — | ❌ não usar |

### 2.2 "Relatório de Vendas" (Geral) — `parseVisioSalesReport`

| Campo | Uso | Extraído hoje |
|---|---|---|
| Estabelecimento | validação | ✅ |
| **Faturamento** | indicador `faturamento` | ✅ |
| **Ticket médio** | indicador `ticket_medio` | ✅ |
| **Cupons de vendas** (= quantidade de vendas) | exibição + base do ticket | ✅ |
| **Cupons válidos** | exibição/auditoria | ✅ |
| **Métodos de pagamento** (qtd + R$ por método) | **persistir p/ conferência (decisão 5)** — fora do cálculo | ❌ **adicionar** |
| Gráficos diários | — | ❌ não usar |

> Não tem PPD, Torque nem Mix.

### 2.3 O que o PDF **não** informa (limita as validações)

| Validar | No PDF? | Solução |
|---|---|---|
| Estabelecimento / unidade | ✅ | `mesmaUnidadeVisio` — **bloqueio** |
| Tipo (Vendas × Produtos) | ✅ título + âncoras | **bloqueio duro** |
| Números pt-BR / quantidade inteira | ✅ | `parseQuantidadeBR` + assert — **bloqueio** |
| Canal Loja × Geral (Produtos) | ❌ sem texto | cross-check faturamento → **alerta crítico (≥90%) / alerta (60–90%)** + **checkbox obrigatório** |
| Mês / Ano / Período | ❌ sem texto | seleção do usuário + **aviso fixo + checkbox obrigatório** (texto exato da decisão 2) |
| Integridade do mix | ✅ parcial | validação cruzada — **alerta** |

---

## 3. Estados da competência (state machine)

`bonificacao_competencia.status ∈ { 'aberta', 'fechada', 'reaberta', 'legado_sem_fechamento' }`

```
            (competência ainda não existe = tratada como 'aberta')
                              │
                    ┌─────────┴──────────┐
     rollout único  │                    │  confirmar fechamento
   (script legado)  ▼                    ▼  (2 PDFs + 2 checkboxes + validações OK)
        ┌───────────────────────┐   ┌──────────┐
        │ legado_sem_fechamento │   │  aberta  │
        │  snapshot v1 imut.    │   └────┬─────┘
        │  origem=legado_pre_…  │        │ confirmar fechamento
        └──────────┬────────────┘        ▼
                   │ importar 1º      ┌──────────┐
                   │ fechamento real  │  fechada │  ← snapshot vN imut. · origem=fechamento_visio
                   └─────────────────▶│          │     versao_atual = N
                                      └────┬─────┘
                        reabrir (motivo +  │ ▲
                        permissão EXCLUIR) │ │ re-confirmar → snapshot vN+1 · versao_atual=N+1
                                           ▼ │
                                      ┌──────────┐
                                      │ reaberta │  ← cálculo AO VIVO (provisório)
                                      │          │     fechamento anterior preservado só p/ auditoria
                                      └──────────┘
```

| status | `obterMes()` serve | `bonificacaoDefinitiva` | edição de lançamento diário / REV daquela competência |
|---|---|---|---|
| **aberta** | cálculo ao vivo (projeção/diário + manuais + rev) | `null` | permitida |
| **fechada** | **snapshot `versao_atual`** (congelado, não recalcula) | do snapshot | **bloqueada** — "reabra para alterar" |
| **reaberta** | cálculo ao vivo, marcado **provisório** | `null` | permitida |
| **legado_sem_fechamento** | **snapshot legado `versao_atual`** (congelado) | do snapshot legado, **rotulado `legado_pre_refatoracao`** (nunca "oficial Visio") | **bloqueada** |

Transições e o que cada uma cria/audita:

| Transição | Gatilho | Efeito |
|---|---|---|
| `(nada)` → `legado_sem_fechamento` | script de rollout (1×, idempotente) | cria `competencia` + `snapshot v1` (origem `legado_pre_refatoracao`) com o resultado que o sistema calculava naquele momento. Auditoria `competencia_legado_capturada`. |
| `aberta` → `fechada` | confirmar fechamento | persiste `bonificacao_fechamento_mensal` (2 metades) + cria `snapshot v1` (origem `fechamento_visio`) + `status='fechada'`, `versao_atual=1`. Auditoria `fechamento_confirmado`. |
| `legado_sem_fechamento` → `fechada` | importar 1º fechamento real | idem, `snapshot v2` (v1 legado preservado). `versao_atual=2`. |
| `fechada` → `reaberta` | reabrir (motivo 3–500, permissão `BONIFICACAO_MENSAL_EXCLUIR`) | `status='reaberta'`. **Nada apagado.** Auditoria `competencia_reaberta` (usuário, data, motivo, hashes dos PDFs vigentes). |
| `reaberta` → `fechada` | re-confirmar | novo upsert em `bonificacao_fechamento_mensal` + `snapshot v(N+1)` + `status='fechada'`, `versao_atual=N+1`. Auditoria `competencia_refechada` + diff dos valores oficiais. |

> **Nunca:** apagar/alterar um snapshot; usar `bonificacao_fechamento_mensal` como resultado
> quando `status != 'fechada'`; recalcular dinamicamente uma competência `fechada`/`legado_*`.

---

## 4. `obterMes()` — árvore de decisão (espelha §3 exatamente)

```
obterMes(unidade, ano, mes):
  comp = SELECT * FROM bonificacao_competencia WHERE unidade+ano+mes         // pode ser null

  ── comp?.status == 'fechada'  OU  comp?.status == 'legado_sem_fechamento' ──
     snap = SELECT snapshot FROM bonificacao_competencia_snapshot
            WHERE competencia_id = comp.id AND versao = comp.versao_atual
     RETURN {
       ...snap.snapshot,                    // indicadores, resumo, elegibilidade, bonificação — tudo pronto
       congelado: true,
       origemResultado: snap.snapshot.origem, // 'fechamento_visio' | 'legado_pre_refatoracao'
       fechamentoStatus: comp.status == 'fechada' ? 'fechado' : 'legado_sem_fechamento',
       podeEditarDiario: false,
     }
     // NÃO lê bonificacao_lancamentos_diarios para montar indicadores.
     // (o calendário diário read-only, se a tela pedir, é uma query à parte, sem recomputar agregados)

  ── comp?.status == 'aberta'  OU  comp?.status == 'reaberta'  OU  comp == null ──
     lancamentos = SELECT ... bonificacao_lancamentos_diarios (competência)
     revMensal   = obterRevMensal(...)
     projecao    = projecaoFaturamento(lancamentos, ...)
     // fonte de CADA indicador — SEM fechamento (status != 'fechada' ⇒ fechamento não é resultado):
     mix         = mixMensalPonderado(lancamentos)                 // projeção
     faturamento = projecao.acumulado                              // projeção
     ticket      = ticketMedioPonderado(lancamentos)               // projeção
     ...(cmv/avaliacao/cancelamentos/pedidos_chamado/pesquisas = manual, como hoje)
     indicadores = { por indicador: evaluateBonusMetric(valor, metaVigente) }
     RETURN {
       ...,
       congelado: false,
       fechamentoStatus: comp?.status == 'reaberta' ? 'reaberto'
                        : (mesCalendarioEncerrado ? 'aguardando_fechamento' : 'aberto'),
       resumo: { bonificacaoProjetada: <soma faixas>, bonificacaoDefinitiva: null, ... },
       provisorio: true,
       podeEditarDiario: true,
       // dados do bonificacao_fechamento_mensal entram SÓ na prévia da importação, nunca aqui
     }
```

**Ponto crítico (ajuste 7):** mesmo que exista fisicamente uma linha
`bonificacao_fechamento_mensal` com as 2 metades (porque a competência já foi
`fechada` um dia e depois `reaberta`), enquanto `comp.status == 'reaberta'` o
`obterMes()` **ignora** esses valores e recalcula ao vivo. O resultado oficial só
volta quando o usuário re-confirmar (→ `fechada`, novo snapshot).

`mesFechado` (hoje só calendário) **deixa de liberar** o definitivo sozinho:
`bonificacaoDefinitiva != null` ⟺ `comp.status ∈ {'fechada','legado_sem_fechamento'}`.

---

## 5. Modelo de dados

### 5.1 `bonificacao_mix_mensal` → `bonificacao_fechamento_mensal` (rename + evoluções, migration 075)

Guarda a **extração oficial vigente** da competência (as 2 metades). É atualizável
no re-fechamento. **Não é o registro imutável** — esse é o snapshot.

```
bonificacao_fechamento_mensal        UNIQUE(unidade_id, ano, mes)   CHECK ano 2000-2100 · mes 1-12
├─ id, organizacao_id, unidade_id, ano, mes
│
├─ ── PRODUTOS (Relatório de Produtos mensal · Loja/Balcão) ──
│  produtos_qtd_sanduiches   int  CHECK >=0     (RENAME de qtd_sanduiches)
│  produtos_qtd_bebidas      int  CHECK >=0     (RENAME)
│  produtos_qtd_adicionais   int  CHECK >=0     (RENAME)
│  produtos_qtd_diversos     int  CHECK >=0     (RENAME)
│  produtos_pct_bebidas_pdf     numeric(6,3)    (RENAME de percentual_bebidas_pdf)
│  produtos_pct_adicionais_pdf  numeric(6,3)    (RENAME)
│  produtos_pct_diversos_pdf    numeric(6,3)    (RENAME)
│  produtos_faturamento_loja    numeric(14,2)   (RENAME de faturamento_loja)
│  produtos_ppd                 numeric(10,2)   (RENAME de ppd_loja)
│  produtos_torque              numeric(10,2)   ADD
│  produtos_perdas              numeric(14,2)   ADD
│  produtos_fat_sanduiches      numeric(14,2)   ADD
│  produtos_pct_fat_sanduiches  numeric(6,3)    ADD
│  produtos_total_itens         int  CHECK >=0  ADD
│  produtos_estabelecimento     text            (RENAME de estabelecimento)
│  produtos_canal_confirmado    boolean NOT NULL DEFAULT false   ADD   (checkbox decisão 1)
│  produtos_origem              text CHECK IN (visio|manual|misto)   (RENAME de origem)
│  produtos_hash_arquivo, produtos_arquivo_storage   (RENAME de hash_arquivo/arquivo_storage)
│  produtos_usuario_id  uuid → perfis(id) ON DELETE SET NULL   (RENAME de usuario_id)
│  produtos_usuario_nome, produtos_atualizado_em                (RENAME)
│
├─ ── VENDAS (Relatório de Vendas mensal · Geral) ──
│  vendas_faturamento       numeric(14,2)  CHECK >=0   ADD
│  vendas_ticket_medio      numeric(10,2)  CHECK >=0   ADD
│  vendas_cupons_validos    int  CHECK >=0             ADD
│  vendas_cupons_vendas     int  CHECK >=0             ADD
│  vendas_metodos_pagamento jsonb NOT NULL DEFAULT '[]'   ADD   [{metodo,qtd,valor}]
│  vendas_estabelecimento   text                       ADD
│  vendas_origem            text CHECK IN (visio|manual|misto)   ADD
│  vendas_hash_arquivo, vendas_arquivo_storage          ADD
│  vendas_usuario_id  uuid → perfis(id) ON DELETE SET NULL   ADD
│  vendas_usuario_nome, vendas_atualizado_em            ADD
│
├─ periodo_confirmado_usuario  boolean NOT NULL DEFAULT false   ADD   (checkbox decisão 2)
├─ manual_override   jsonb NOT NULL DEFAULT '{}'    (mantém)
└─ criado_em, atualizado_em                          (mantém)

CHECK bfm_completo:   -- a linha só existe depois de um fechamento confirmado
  produtos_qtd_sanduiches IS NOT NULL
  AND vendas_faturamento    IS NOT NULL
  AND produtos_canal_confirmado = true
  AND periodo_confirmado_usuario = true

FK organizacao_id → organizacoes(id)  ON DELETE RESTRICT   (era CASCADE — ajuste 6)
FK unidade_id     → unidades(id)      ON DELETE RESTRICT   (era CASCADE)
Índices: idx_bmm_* → idx_bfm_* (mesmas colunas). UNIQUE(unidade_id,ano,mes) mantido.
Trigger trg_bmm_upd → trg_bfm_upd (mesma function bonificacao_set_atualizado_em).
RLS: policy recriada com novo nome, MESMA expressão (auth_unidade_ids / is_platform_superadmin).
```

> **Sem coluna `status` no fechamento** (ajuste 7): o estado vive só em
> `bonificacao_competencia`. A linha do fechamento existir já significa "houve
> confirmação"; qual resultado vale é `comp.status`.

### 5.2 `bonificacao_competencia` (nova, migration 075)

```
bonificacao_competencia               UNIQUE(unidade_id, ano, mes)   CHECK ano/mes
├─ id, organizacao_id, unidade_id, ano, mes
├─ status         text NOT NULL DEFAULT 'aberta'
│                 CHECK IN ('aberta','fechada','reaberta','legado_sem_fechamento')
├─ versao_atual   int  NOT NULL DEFAULT 0        (0 = nunca congelada; ≥1 = aponta o snapshot vigente)
├─ fechamento_id  uuid → bonificacao_fechamento_mensal(id)  ON DELETE RESTRICT   (nullable; null p/ legado sem fechamento real)
├─ fechada_em, fechada_por_id (→perfis SET NULL), fechada_por_nome
├─ reaberta_em, reaberta_por_id (→perfis SET NULL), reaberta_por_nome, reabertura_motivo   (última reabertura)
├─ legado_capturado_em                            (só quando origem legado)
└─ criado_em, atualizado_em

FK organizacao_id → organizacoes(id)  ON DELETE RESTRICT   (ajuste 6)
FK unidade_id     → unidades(id)      ON DELETE RESTRICT
Índices: (unidade_id, ano desc, mes desc); (organizacao_id); (status)
Trigger de atualizado_em.
RLS: mesma expressão dos demais.
```

### 5.3 `bonificacao_competencia_snapshot` (nova, migration 075) — **APPEND-ONLY IMUTÁVEL**

```
bonificacao_competencia_snapshot      UNIQUE(competencia_id, versao)
├─ id
├─ competencia_id  uuid NOT NULL → bonificacao_competencia(id)  ON DELETE RESTRICT   (ajuste 6)
├─ organizacao_id  uuid NOT NULL → organizacoes(id)  ON DELETE RESTRICT              (desnormalizado p/ RLS)
├─ unidade_id      uuid NOT NULL → unidades(id)      ON DELETE RESTRICT
├─ ano, mes        int  NOT NULL
├─ versao          int  NOT NULL CHECK (versao >= 1)
├─ origem          text NOT NULL CHECK IN ('fechamento_visio','legado_pre_refatoracao')
├─ snapshot        jsonb NOT NULL      ← §5.4
├─ criado_em       timestamptz NOT NULL DEFAULT now()
├─ criado_por_id   uuid → perfis(id) ON DELETE SET NULL
├─ criado_por_nome text
└─ motivo          text               (na versão que segue uma reabertura: o motivo dela)

-- NÃO existe `substituido_em` (ajuste 5). A versão vigente é bonificacao_competencia.versao_atual.

Índices: (competencia_id, versao desc); (unidade_id, ano, mes)
RLS: mesma expressão.

-- IMUTABILIDADE NO BANCO (ajuste 5):
CREATE FUNCTION bonificacao_snapshot_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bonificacao_competencia_snapshot é append-only — % proibido (id=%)',
    TG_OP, COALESCE(OLD.id, NEW.id)
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bcs_no_update BEFORE UPDATE ON bonificacao_competencia_snapshot
  FOR EACH ROW EXECUTE FUNCTION bonificacao_snapshot_imutavel();
CREATE TRIGGER trg_bcs_no_delete BEFORE DELETE ON bonificacao_competencia_snapshot
  FOR EACH ROW EXECUTE FUNCTION bonificacao_snapshot_imutavel();
-- (INSERT continua livre — é append-only.)
```

### 5.4 Conteúdo do `snapshot` JSONB

```json
{
  "escopoBonificacao": "unidade",
  "unidade": { "id": "…", "nome": "…", "organizacaoId": "…" },
  "competencia": { "ano": 2026, "mes": 8 },
  "origem": "fechamento_visio",              // ou "legado_pre_refatoracao"
  "versao": 1,
  "geradoEm": "2026-09-05T…Z",

  "fonte": {                                  // ausente quando origem = legado_pre_refatoracao
    "vendas":   { "hash": "…", "estabelecimento": "Subway Teresina Saci", "origem": "visio" },
    "produtos": { "hash": "…", "estabelecimento": "Subway Teresina Saci",
                  "origem": "visio", "canalConfirmadoPeloUsuario": true },
    "periodoConfirmadoPeloUsuario": true
    // F4 acrescenta storage/importadoEm ao persistir os arquivos
  },

  "valoresOficiais": {
    "faturamento": 109613.74, "ticketMedio": 52.47, "quantidadeVendas": 2089, "cuponsValidos": 2089,
    "sanduichesSaladas": 2533, "bebidas": 1086, "adicionais": 613, "diversos": 508,
    "ppd": 57, "torque": 53.33, "perdas": 0, "fatSanduiches": 41000.00, "pctFatSanduiches": 62.4,
    "totalItens": 12761, "produtosFuncionais": 0, "faturamentoLoja": 41000.00,
    "metodosPagamento": [ { "metodo": "IFOOD ONLINE", "qtd": 147, "valor": 6649.45 }, … ],
    // ÚNICO percentual do mix — a regra (qtd / qtd_sanduiches * 100). Não há
    // "percentuaisPdf"/"percentuaisCalculados" lado a lado: um valor por indicador.
    "percentuais": { "bebidas": 42.8741, "adicionais": 24.1998, "diversos": 20.0553 }
  },

  "indicadores": {
    "bebidas": {
      "valorAtual": 42.8741, "fonte": "fechamento_visio",
      "formula": "1086 / 2533 * 100",
      "meta": { "direcao": "higher_is_better",
                "faixas": [ { "ordem": 1, "tipo": "limite_minimo", "valorMin": 43, "bonus": 25 }, … ] },
      "faixaAtual": null, "bonusAtual": 0, "proximaFaixa": {…}, "faltante": 0.13,
      "faixaMaxima": {…}, "bonusMaximo": 75, "status": "meta_nao_atingida", "temBonusDefinido": true
    },
    "adicionais": {…}, "diversos": {…}, "faturamento": {…}, "ticket_medio": {…},
    "cmv": { "valorAtual": …, "fonte": "manual", "formula": "media diaria" },
    "avaliacao_ifood": {…}, "rev": {…}, "pesquisas": {…}, "cancelamentos": {…}, "pedidos_chamado": {…}
  },

  "elegibilidade": { "status": "elegivel|nao_elegivel|em_acompanhamento",
                     "criterios": { "nota_ifood": {…}, "rev": {…}, "pesquisas": {…} },
                     "motivosInelegibilidade": [] },
  "superRestaurante": { "dentroDaMeta": 3, "totalComMeta": 3, "pontosDeAtencao": [] },

  "bonificacao": { "bruta": 350.00, "definitiva": 350.00, "maxima": 800.00,
                   "metasAtingidas": 4, "metasComRegra": 6 },

  "metadados": {
    "codigoVersao": "<git sha do deploy no momento do fechamento>",
    "confirmadoPor": { "id": "…", "nome": "…" },        // ajuste 1
    "avisosImportacao": [ "O faturamento do Relatório de Produtos representa 37% do total de vendas.", … ],
    // Conferência TÉCNICA da importação — nunca é fonte de indicador, nunca é
    // "um segundo valor" da competência. Só existe para revisar o arquivo.
    "conferenciaImportacao": {
      "percentuaisImpressosNoPdf": { "bebidas": 42.9, "adicionais": 24.2, "diversos": 20.1 },
      "divergenciaPercentualPP":   { "bebidas": 0.03, "adicionais": 0.00, "diversos": 0.04 },
      "crossChecks": { "produtosFatVsVendasFat": 0.37, "produtosFatVsRegistrado": 0.02, "principaisVsRegistrado": 0.004 }
    },
    "reaberturas": []   // versões > 1: [{ "versaoAnterior": 1, "motivo": "…", "por": "…", "em": "…" }]
  }
}
```

- **`valoresOficiais.percentuais`** é o único percentual do mix. O percentual
  que o PDF imprime entra só em `metadados.conferenciaImportacao.percentuaisImpressosNoPdf`
  (mais a diferença em p.p.) — dado técnico de conferência, jamais consumido
  como resultado. Snapshot imutável: o formato acima é o que a F4 congela.

- **legado_pre_refatoracao:** `origem` marcada, `fonte` omitida (ou
  `{ "tipo": "recalculo_diario_no_rollout" }`), `valoresOficiais` = o que a
  projeção/soma diária produzia, `metadados.confirmadoPor` = usuário/rotina do
  rollout. A UI **nunca** rotula isso como "Oficial Visio" — usa "Resultado
  histórico (pré-Visio mensal)".

### 5.5 Auditoria (`plataforma_auditoria`)

Ações: `bonificacao_mensal.fechamento_confirmado` · `…competencia_reaberta` ·
`…competencia_refechada` · `…competencia_legado_capturada` · `…fechamento_corrigido`.
Cada uma: unidade, competência, usuário, data, motivo (reabertura),
`arquivos: { antes:[{tipo,hash,storage}], depois:[…] }`, diff dos `valoresOficiais`.

---

## 6. Parsers e validação da importação

### 6.1 `visio-parser.js`

- `detectarTipoRelatorio(matriz) → 'vendas' | 'produtos' | null` — **bloqueio duro** se o tipo ≠ slot.
- `parseVisioProductReport`: expor `torque`, `perdas`; adicionar `fatSanduiches`, `pctFatSanduiches`, `totalItens`.
- `parseVisioSalesReport`: adicionar `metodosPagamento: [{metodo, qtd, valor}]`.
- Tudo via `parseNumeroBR` / `parseQuantidadeBR` / `parseMoedaBR` (já garante pt-BR + inteiro onde é contagem; assert já feito).

### 6.2 Regras — bloqueia × alerta

| Situação | Ação |
|---|---|
| Falta um dos 2 PDFs | **bloqueia** |
| Tipo trocado (Vendas↔Produtos) | **bloqueia** |
| Estabelecimento de um PDF ≠ unidade (token) | **bloqueia** |
| Estabelecimentos dos 2 PDFs diferentes entre si | **bloqueia** |
| Quantidade fracionária onde é contagem | **bloqueia** |
| Checkbox "filtro Loja/Balcão" **não** marcado | **bloqueia** confirmar |
| Checkbox "competência confere" **não** marcado | **bloqueia** confirmar |
| Já existe competência `fechada` | **bloqueia** — exige reabrir antes |
| `produtos_faturamento_loja ≥ 90% de vendas_faturamento` | **alerta crítico** (confirmável) |
| `produtos_faturamento_loja` entre 60–90% de `vendas_faturamento` | **alerta** |
| `produtos_faturamento_loja` vs **Σ `faturamento_loja` diário** do mês, desvio > 10% | **alerta** (ajuste 2) |
| `%PDF` do mix ≠ `%` recalculado > 1,5 p.p. | **alerta** |
| Σ diários do mês (mix) diverge > 10% do fechamento | **alerta** |

### 6.3 Cross-checks (todos **alerta**, nunca cálculo — ajuste 2)

1. `produtos_faturamento_loja` vs `vendas_faturamento` (canal Loja ⊂ Geral).
2. `produtos_faturamento_loja` vs **Σ `faturamento_loja`** dos relatórios diários já lançados na competência (quando houver dias).

Nenhum dos dois vira regra absoluta de negócio nem fonte de valor.

---

## 7. Fluxo de fechamento

### 7.1 Tela — **Bonificação Mensal → Fechamento Mensal Visio** (substitui a aba atual)

```
Mês [▾]  Ano [▾]        Unidade: 🏪 <sessão> (fixa)

┌ Relatório de Vendas — mês inteiro (Geral) ┐    [PDF]  *obrigatório*
┌ Relatório de Produtos — mês inteiro (Loja/Balcão) ┐  [PDF]  *obrigatório*

[ Analisar relatórios ]   [ Confirmar fechamento ]  (bloqueado até prévia OK + 2 checkboxes)
```

### 7.2 Prévia consolidada (`POST /fechamento-mensal/preview`, 2 arquivos — não persiste)

Resposta (implementado na F3):

```
preview = {
  competencia: { ano, mes, label },
  unidade: { id, nome },
  vendas:   { faturamento, ticketMedio, quantidadeVendas, cuponsValidos, estabelecimento, metodosPagamento[] },
  produtos: { sanduichesSaladas, bebidas, adicionais, diversos, ppd, torque, perdas,
              fatSanduiches, pctFatSanduiches, totalItens, faturamentoLoja, estabelecimento,
              percentuais }              ← ÚNICO percentual do mix (a regra)
  camposCorrigidos: { vendas[], produtos[] },
  validacao: {
    bloqueios[],                         ← impedem confirmar
    alertas[{ tipo, msg }],              ← nunca bloqueiam, nunca mudam cálculo
    conferencia: {                        ← TÉCNICO, só para revisar a importação
      crossChecks,
      percentuais: { regra, impressosNoPdf, divergenciaPP },
      registradoNaCompetencia            ← o que já está lançado p/ a competência (base dos alertas)
    }
  },
  resultadoOficial,                       ← formato canônico §5.4 (via montarResultadoFechamentoOficial)
  prontoParaConfirmar: bloqueios.length === 0,
  persistido: false
}
```

Tela (F7):

```
FECHAMENTO — Agosto / 2026 · <unidade>

VENDAS (Relatório de Vendas · Geral)
  Faturamento · Quantidade de vendas · Cupons válidos · Ticket médio · Estabelecimento
  Métodos de pagamento (lista)                       ← exibido, fora do cálculo

PRODUTOS (Relatório de Produtos · Loja/Balcão)
  Sanduíches/Saladas · Bebidas → % · Adicionais → % · Diversos → %   (um % por indicador)
  PPD · Torque · Perdas · Fat. sanduíches/saladas · Faturamento (Loja) · Estabelecimento

VALIDAÇÃO
  Bloqueios (impedem confirmar) · Alertas de importação (informativos)

☐  Confirmo que o Relatório de Produtos foi exportado com filtro Loja/Balcão.
☐  A Visio não informa o período deste PDF de forma estruturada. Confirmo que o arquivo
    corresponde à competência selecionada (Agosto / 2026).

              [ Confirmar fechamento ]   (habilita só com prévia OK + os 2 ☑)
```

> Nenhum "valor Central × Visio × diferença", nenhuma "soma dos diários" — nem na
> prévia, nem na Bonificação. Os cross-checks vivem só em `validacao.conferencia`,
> como verificação técnica do arquivo importado.

### 7.3 Confirmar (`POST /fechamento-mensal`, 2 arquivos + 2 flags) — transação

> **Correção v3.1 (obrigatória antes da F3):** o snapshot do fechamento **NÃO** é
> fabricado por `obterMes()`. Motivos:
> - enquanto a competência é `aberta`/`reaberta`, `obterMes()` **tem que** ignorar
>   `bonificacao_fechamento_mensal` e calcular ao vivo (§4 / ajuste 7);
> - não dá para setar `status='fechada'` antes de criar o snapshot, porque
>   `obterMes()` de uma competência `fechada` tentaria servir `snapshot versao_atual`,
>   que ainda não existe.
>
> A F3/F4 cria uma **função pura** `montarResultadoFechamentoOficial(...)` que recebe
> os dados oficiais já extraídos e devolve o **mesmo formato canônico do §5.4** —
> a mesma coisa que `obterMes()` de uma competência `fechada` vai devolver depois.

**Fluxo transacional — implementado (F4) como RPC `bonificacao_congelar_competencia`:**
o cliente Supabase-JS não tem transação multi-statement; os passos 3–6 rodam
dentro de UMA função plpgsql (transação implícita). O serviço monta os 2 jsonb
(`p_fechamento`, `p_snapshot` = §5.4 via `montarResultadoFechamentoOficial`) e
chama a RPC. `reabrir` = `bonificacao_reabrir_competencia`.

```
1. validar os 2 PDFs (6.2) + os 2 checkboxes           [serviço, antes da RPC]
2. (F7) sobe os 2 PDFs no Storage — PDFs de snapshots anteriores NUNCA apagados
3. upsert bonificacao_fechamento_mensal (2 metades, flags, origem por metade)   [RPC]
4. resultado = montarResultadoFechamentoOficial({
     vendas:   { faturamento, ticketMedio, cuponsValidos, cuponsVendas, metodosPagamento, ... },
     produtos: { qtdSanduiches, qtdBebidas, qtdAdicionais, qtdDiversos, ppd, torque, ... },
     indicadoresManuaisMensais: { cmv, avaliacaoIfood, cancelamentos, pedidosChamado, pesquisas, rev },
     metasVigentes,                        // metasVigentesPorIndicador(primeiroDia)
     elegibilidadeInputs,                  // { notaIfood, rev, pesquisas } (valor + minimo)
     contexto: { unidade, ano, mes, codigoVersao }
   })
   // NÃO chama obterMes(). Reaproveita as MESMAS funções puras que obterMes usa:
   //   percentualDerivado / evaluateBonusMetric / totalBonificacao /
   //   avaliarElegibilidadeBonificacao / avaliarSuperRestaurante
   // → produz exatamente o JSONB do §5.4.
5. INSERT bonificacao_competencia_snapshot { versao: N (= versao_atual+1),
     origem: 'fechamento_visio', snapshot: resultado, criado_por_* }
6. UPDATE/UPSERT bonificacao_competencia SET
     status = 'fechada', versao_atual = N, fechamento_id = <id>, fechada_em/por = ...
7. auditoria fechamento_confirmado (diff dos valoresOficiais se substituiu)
8. COMMIT
```

**Só depois do COMMIT**, qualquer chamada normal a `obterMes()` encontra
`competencia.status='fechada'` + `versao_atual=N` e **simplesmente devolve o
snapshot** — sem nunca ler `bonificacao_fechamento_mensal` para decidir o resultado.

> **Rollout legado (§9) é o caso permitido de usar `obterMes()`:** ele roda `obterMes()`
> para uma competência que **ainda não existe** (`status` inexistente ⇒ caminho de
> cálculo ao vivo), captura o resultado e **só então** cria a `bonificacao_competencia`
> (`legado_sem_fechamento`) + o snapshot. Não há dependência circular — no instante do
> `obterMes()` a competência não é `fechada`.

### 7.4 Reabrir (`POST /fechamento-mensal/reabrir`, permissão `BONIFICACAO_MENSAL_EXCLUIR`)

- body: `{ ano, mes, motivo }` (motivo 3–500).
- `bonificacao_competencia.status='reaberta'` + `reaberta_*`. **Nada apagado.**
- auditoria `competencia_reaberta`.
- a partir daí `obterMes()` volta ao cálculo ao vivo (provisório) até o re-fechamento.

### 7.5 Ver PDFs / snapshots

- `GET /fechamento-mensal/arquivo?ano&mes&tipo=vendas|produtos` → PDF vigente.
- `GET /fechamento-mensal/snapshots?ano&mes` → lista de versões (versao, origem, criado_por, motivo).
- `GET /fechamento-mensal/snapshot/:versao/arquivo?tipo=…` → PDF daquela versão (auditoria).

---

## 8. Migration 075 — segurança (ajuste 4, 5, 6)

Arquivos: `075_bonificacao_fechamento_mensal.sql` + `075_rollback.sql` + `backend/test/migration-075.test.js`.

### 8.1 Preflight (dentro da própria migration, antes de qualquer DDL)

```sql
DO $$ BEGIN
  IF (SELECT count(*) FROM bonificacao_mix_mensal) > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: bonificacao_mix_mensal tem % linha(s). Esta migration só roda com a '
      'tabela vazia (a 074 nunca foi usada em produção — confirmado 0 linhas). '
      'Migre os dados manualmente antes de aplicar a 075.',
      (SELECT count(*) FROM bonificacao_mix_mensal);
  END IF;
END $$;
```
Como toda a 075 roda numa transação, o `RAISE` reverte tudo — schema e dados
intactos.

### 8.2 DDL — **só não-destrutivo**

- `ALTER TABLE bonificacao_mix_mensal RENAME TO bonificacao_fechamento_mensal`
- `ALTER TABLE … RENAME COLUMN …` (13 renames)
- `ALTER TABLE … ADD COLUMN …` (metade Vendas + torque/perdas/fat_sanduiches/total_itens/canal_confirmado/periodo_confirmado_usuario)
- `ALTER TABLE … DROP CONSTRAINT …_fkey, ADD CONSTRAINT … ON DELETE RESTRICT` (org, unidade)
- `ALTER TABLE … ADD CONSTRAINT bfm_completo CHECK (…)`
- `ALTER INDEX idx_bmm_* RENAME TO idx_bfm_*` · `ALTER TRIGGER trg_bmm_upd … RENAME`
- `DROP POLICY … ; CREATE POLICY …` (mesma expressão, nome novo)
- `CREATE TABLE bonificacao_competencia` · `CREATE TABLE bonificacao_competencia_snapshot`
- `CREATE FUNCTION bonificacao_snapshot_imutavel` + 2 triggers (UPDATE/DELETE → RAISE)
- índices/trigger/RLS das 2 tabelas novas
- **Nenhum** `DROP COLUMN` / `DROP TABLE` / `TRUNCATE` / `DELETE` / `UPDATE` de dado.

### 8.3 Constraints / FKs / índices — validação (bloco comentado no fim, para rodar à parte)

```sql
-- \d+ bonificacao_fechamento_mensal      -> colunas, tipos, checks, FKs ON DELETE RESTRICT
-- \d+ bonificacao_competencia            -> status CHECK, versao_atual, FKs RESTRICT
-- \d+ bonificacao_competencia_snapshot   -> UNIQUE(competencia_id,versao), FKs RESTRICT, 2 triggers
-- SELECT count(*) FROM bonificacao_fechamento_mensal;   -- inalterado (0)
-- UPDATE bonificacao_competencia_snapshot SET versao = versao;   -- deve FALHAR (trigger)
-- DELETE FROM bonificacao_competencia_snapshot;                  -- deve FALHAR (trigger)
```

### 8.4 `migration-075.test.js` (roda no Supabase de TESTE, nunca produção)

```
setup: garante 074 aplicada no banco de teste (aplica se ausente).

CENÁRIO A — preflight aborta com dados:
  1. INSERT 1 linha em bonificacao_mix_mensal
  2. aplicar 075  → espera ERRO contendo "ABORTADO"
  3. assert: tabela ainda se chama 'bonificacao_mix_mensal'
             a linha continua lá, com os mesmos valores
             não existe 'bonificacao_fechamento_mensal' / 'bonificacao_competencia' / '_snapshot'
             nenhuma coluna nova
  4. DELETE a linha (limpeza)

CENÁRIO B — 0 linhas, aplica completo (CAMINHO REAL):
  1. assert count(bonificacao_mix_mensal) == 0
  2. aplicar 075  → sucesso
  3. assert:
     - 'bonificacao_fechamento_mensal' existe; 'bonificacao_mix_mensal' não
     - colunas renomeadas presentes (produtos_qtd_sanduiches, …) + novas (vendas_*, produtos_torque, …)
     - FKs org/unidade = ON DELETE RESTRICT (era CASCADE)
     - CHECK bfm_completo presente
     - índices idx_bfm_* ; trigger trg_bfm_upd ; policy rls_bonificacao_fechamento_mensal_tenant
     - 'bonificacao_competencia' e '_snapshot' existem, com FKs RESTRICT, UNIQUE, RLS
     - INSERT em _snapshot OK ; UPDATE nele → ERRO ; DELETE nele → ERRO (imutabilidade)
     - DELETE de uma bonificacao_competencia que tem snapshot → ERRO (RESTRICT)
  4. aplicar 075_rollback.sql → sucesso
  5. assert: schema volta EXATAMENTE ao estado 074 (nome, colunas, FKs CASCADE, sem tabelas novas)

CENÁRIO C — idempotência do rollback: rollback 2× não quebra (guardas IF EXISTS).
```

### 8.5 `075_rollback.sql`

Reverte, em ordem inversa: drop triggers/função de imutabilidade → drop `_snapshot`
→ drop `bonificacao_competencia` → drop CHECK/colunas adicionadas → FKs de volta
para `ON DELETE CASCADE` → renomear índices/trigger/policy de volta → renomear
colunas de volta → `RENAME TABLE bonificacao_fechamento_mensal TO bonificacao_mix_mensal`.
Tudo com `IF EXISTS`. Sem perda (as colunas dropadas foram criadas pela 075).

---

## 9. Rollout do histórico legado (ajuste 3) — script, não migration

`backend/scripts/capturar-competencias-legado.mjs` (executado 1×, após F2–F6 no deploy, **antes** de "go-live" do gate de pagamento):

```
para cada (unidade_id) ativa:
  para cada (ano, mes) com  ano-mes < mês corrente  E  há dados
      (≥1 linha em bonificacao_lancamentos_diarios OU bonificacao_rev_mensal na competência):
    se já existe bonificacao_competencia → pula (idempotente)
    resultado = obterMes(unidade, ano, mes)          // status inexistente ⇒ cálculo ao vivo (projeção/diário)
    INSERT bonificacao_competencia { status:'legado_sem_fechamento', versao_atual:1, legado_capturado_em:now() }
    INSERT bonificacao_competencia_snapshot {
      versao:1, origem:'legado_pre_refatoracao',
      snapshot: { ...resultado, origem:'legado_pre_refatoracao', fonte: {tipo:'recalculo_diario_no_rollout'} },
      criado_por_nome:'rollout legado <data>'
    }
    auditoria competencia_legado_capturada
```

- Depois disso, essas competências **param de recalcular** — `obterMes()` serve o snapshot.
- Rotuladas na UI como **"Resultado histórico (pré-Visio mensal)"**, nunca "Oficial Visio".
- Podem receber um fechamento Visio real depois → viram `fechada` (snapshot v2).
- Dry-run obrigatório (`--dry-run` imprime o que gravaria) antes da execução real.

---

## 10. Elegibilidade e segurança financeira

`obterMes().resumo`:

| Campo | Regra |
|---|---|
| `bonificacaoProjetada` | sempre (melhor fonte disponível hoje) |
| `bonificacaoDefinitiva` | `comp.status ∈ {'fechada','legado_sem_fechamento'}` **e** elegível → valor do snapshot. Senão `null`. |
| `fechamentoStatus` | `'aberto'` \| `'aguardando_fechamento'` \| `'fechado'` \| `'reaberto'` \| `'legado_sem_fechamento'` |
| `origemResultado` | `'ao_vivo'` \| `'fechamento_visio'` \| `'legado_pre_refatoracao'` |
| `liberadoParaPagamento` | `bonificacaoDefinitiva != null` |

- Gate de elegibilidade (Nota iFood + REV + Pesquisas) continua igual, aplicado **sobre** o definitivo.
- Hero: `aguardando_fechamento` → *"Projeção · pagamento após o fechamento oficial da Visio"*; `fechado` → *"Resultado final"*; `legado_sem_fechamento` → *"Resultado histórico"*.

---

## 11. Companion obrigatório — exclusão de empresa/unidade (ajuste 6)

Com FKs `ON DELETE RESTRICT` nas 3 tabelas, **F6** precisa (senão `excluir_organizacao_definitivamente` estoura 23503):

- `impactoExclusaoEmpresa` / `impactoExclusaoUnidade`: adicionar métrica **bloqueante**
  `bonificacaoFechamentos` / `bonificacaoSnapshots` → painel mostra "arquivar, não excluir".
- `excluir_organizacao_definitivamente` (migration 055): **não** limpar snapshots — o correto é
  a exclusão física ser **recusada** quando há snapshot financeiro (política explícita), ou
  um passo de arquivamento antes. Decisão fina fica para F6, mas a arquitetura já fixa:
  **snapshot financeiro nunca é deletado por exclusão de empresa/unidade.**

---

## 12. Frontend — arquivos afetados

| Arquivo | Mudança |
|---|---|
| `bonificacaoMensalImportModal.js` | aba "Fechamento mensal" → **2 dropzones obrigatórios** + mês/ano + **2 checkboxes**; prévia consolidada (7.2); remove o modo "1 PDF". |
| `bonificacaoMensal.js` | `fechamentoMensalHtml` → **sem comparativo**; mostra status da competência + botões (Importar / Reabrir / Ver PDFs / Ver versões). `fonteHtml` → selo único (`Projeção` / `Oficial · Visio` / `Histórico`). Hero → projetada × definitiva + aviso de pagamento. Edição diária bloqueada quando `!podeEditarDiario`. |
| `api.js` | `bonifFechamentoMensalPreview/Confirmar` (2 arquivos + flags); `bonifReabrirFechamento`; `bonifSnapshots`. |
| `styles.css` | modal 2 blocos + alertas crítico/normal + selos. |

---

## 13. Testes (visão consolidada)

- **Puros** (`bonificacaoMensal.calc.test.js`): `resolverIndicadorMensal` chaveado por status; dataset de referência `2533/1086/613/508 → 42,9/24,2/20,1`; `bonificacaoProjetada × bonificacaoDefinitiva`.
- **Parser** (`bonificacao-mensal-visio-parser.test.js`): `detectarTipoRelatorio` + rejeição cruzada; campos novos; pt-BR milhar (feito).
- **Migration** (`migration-075.test.js`): cenários A/B/C (§8.4).
- **Serviço/integração** (`bonificacao-mensal-fechamento-mensal.test.js`): confirmar exige 2 PDFs + 2 flags; bloqueios vs alertas; pós-confirmação `comp.status='fechada'` + snapshot v1; **reabrir → `obterMes` volta a ao vivo mesmo com `bonificacao_fechamento_mensal` presente**; re-confirmar → snapshot v2, v1 intacto; UPDATE/DELETE em snapshot → erro; editar dia de mês fechado → bloqueado; import do PDF mensal real → `3460/1412/785/655` sem erro de integer.
- **Rollout** (`capturar-competencias-legado.test.js`): idempotência, dry-run, snapshot legado com `origem` correta.
- **Manuais**: importar os 2 relatórios reais de agosto/2026 → prévia → 2 ☑ → confirmar → Visão Geral só com o oficial → hero "Resultado final". Reabrir → editar um dia → re-confirmar → v2 no histórico.

---

## 14. Checagem de consistência (estado × obterMes × snapshot × migration)

| Elemento | `competencia.status` possíveis | `obterMes()` faz | Snapshot | Migration garante |
|---|---|---|---|---|
| Mês em andamento | `aberta` (ou linha inexistente) | cálculo ao vivo; `definitiva=null`; edição diária ON | — | `status` default `'aberta'`; `versao_atual` default `0` |
| Mês encerrado sem fechamento | `aberta` | cálculo ao vivo; `fechamentoStatus='aguardando_fechamento'`; `definitiva=null` | — | idem |
| Fechamento confirmado | `fechada` | **serve snapshot `versao_atual`**; `definitiva` do snapshot; edição diária OFF | `versao_atual` (origem `fechamento_visio`) | CHECK `status` aceita `'fechada'`; FK `fechamento_id`; `_snapshot` UNIQUE(competencia,versao) |
| Reaberto | `reaberta` | **cálculo ao vivo** (ignora `bonificacao_fechamento_mensal`); provisório; `definitiva=null`; edição diária ON | versões anteriores **preservadas**, nenhuma alterada | trigger imutabilidade; `reaberta_*` colunas |
| Re-confirmado | `fechada` | serve snapshot `versao_atual` (novo N) | `snapshot vN` novo; `vN-1` intacto (sem `substituido_em`) | INSERT-only em `_snapshot`; `versao_atual` aponta N |
| Histórico pré-refatoração | `legado_sem_fechamento` | **serve snapshot legado**; `definitiva` do snapshot; rótulo "Histórico"; edição diária OFF | `versao_atual` (origem `legado_pre_refatoracao`) | CHECK aceita `'legado_sem_fechamento'`; `fechamento_id` nullable; `legado_capturado_em` |
| Exclusão de competência com snapshot | qualquer | — | protegido | FK `_snapshot.competencia_id → … ON DELETE RESTRICT` |

**Invariantes verificados:**
- Todo `status` que o `obterMes()` testa (§4) está no `CHECK` da migration (§5.2). ✔
- Todo campo que o `obterMes()` lê do snapshot (§4) é escrito por `montarResultadoFechamentoOficial` no formato do §5.4 (`indicadores`, `bonificacao`, `elegibilidade`, `valoresOficiais`, `origem`). ✔
- `obterMes()` **nunca** lê `bonificacao_fechamento_mensal` para montar indicadores — só `bonificacao_competencia` + `_snapshot` (fechada/legado) ou dados ao vivo (aberta/reaberta). O fechamento entra só na prévia/confirmação. ✔ (ajuste 7)
- O snapshot do fechamento é produzido por `montarResultadoFechamentoOficial(...)` (função pura), **não** por `obterMes()`. `status='fechada'` só é gravado **depois** do `INSERT` do snapshot, no mesmo COMMIT. Sem dependência circular. ✔ (correção v3.1)
- `montarResultadoFechamentoOficial` e o caminho "competência fechada" de `obterMes()` produzem **o mesmo formato canônico** (§5.4) — garantido por teste (o snapshot recém-criado, relido por `obterMes()`, é idêntico ao que `montarResultadoFechamentoOficial` retornou). ✔ (correção v3.1)
- Snapshot: criado apenas em confirmar / re-confirmar / rollout legado; nunca UPDATE/DELETE (trigger + sem `substituido_em`). Versão vigente = `versao_atual`. ✔ (ajuste 5)
- FKs de `_snapshot` e `bonificacao_competencia` = `ON DELETE RESTRICT`; nada apaga snapshot financeiro. ✔ (ajuste 6)
- Migration: preflight aborta com dados → cenário A do teste; 0 linhas → cenário B (caminho de produção). ✔ (ajuste 4)
- `bonificacaoDefinitiva` só quando `status ∈ {fechada, legado_sem_fechamento}` + elegível — em nenhum outro caminho. ✔ (ajuste 8)

---

## 15. Fases de execução

| Fase | Entrega | Depende de |
|---|---|---|
| **F1** | `075_*.sql` + `075_rollback.sql` + `migration-075.test.js` (A/B/C). **Não aplica em produção.** Aplica só no Supabase de teste para rodar os testes. | — |
| **F2** | Parser: `detectarTipoRelatorio` + campos novos + testes | F1 (schema p/ tipos) |
| **F3** | Serviço: `processarImportacaoFechamentoMensal` (2 PDFs + 2 flags) + validações 6.2 + `resolverIndicadorMensal` + **`montarResultadoFechamentoOficial(...)` (função pura, §7.3 v3.1)** + `obterMes()` chaveado por `competencia.status` (§4) | F1, F2 |
| **F4 ✅** | Snapshot §5.4 congelado ATOMICAMENTE via RPC `bonificacao_congelar_competencia` (secção 6 da migration 075) — nunca `obterMes()`. `bonificacao_reabrir_competencia`. `confirmarFechamentoMensal` / `reabrirCompetencia` / `capturarLegado` no serviço. `obterMes` já serve o snapshot real (F3). Bloqueio de edição diária/REV/import em `fechada`/`legado` (`exigirCompetenciaEditavel` → 409). Migration 075 validada em Postgres efêmero: cenário D (congelar v1 → refechar bloqueado → reabrir → refechar v2 → v1 intacto → legado). **075 NÃO aplicada em produção.** | F3 |
| **F5** | `bonificacaoProjetada × bonificacaoDefinitiva` + gate de pagamento + hero | F4 |
| **F6** | Reabertura auditada + versionamento + histórico + companion de exclusão (§11) | F4, F5 |
| **F7** | Frontend: modal 2 PDFs + prévia + checkboxes; remover comparativo; selos | F3–F6 |
| **F8** | Script de rollout legado (§9) + validação manual com PDFs reais | F2–F7 |

Cada fase: revisão sua antes do commit. Nada em produção sem OK explícito por fase.

---

## GO — Fase F1 (proposta)

**Escopo F1 (só isto):**
1. `database/migrations/075_bonificacao_fechamento_mensal.sql` — preflight + DDL não-destrutivo (§8.2).
2. `database/migrations/075_rollback.sql` — reversão completa com `IF EXISTS` (§8.5).
3. `backend/test/migration-075.test.js` — análise estática do `.sql` (convenção do projeto, ver
   `migration-060-*.test.js`: não há runner; migrations rodam à mão no SQL Editor) **+** execução
   viva dos cenários A/B/C via `psql` quando `MIGRATION_075_PG_URL` estiver setado (senão, skip
   explícito, como os testes de integração).
4. Executar A/B/C num **Postgres efêmero local** (DB criado só para isto, destruído ao fim) —
   nunca o Supabase de produção, nunca o de integração. Deixar o ambiente exatamente como estava.

> **Nota de infra:** o `.env.test-integracao` só tem credenciais REST do Supabase (sem
> `DATABASE_URL`), e o projeto não tem runner de migration. Por isso a execução A/B/C usa um
> Postgres local descartável, e o teste versionado combina análise estática (sempre roda) com
> execução viva opcional (quando há um Postgres apontado).

**Fora do F1:** qualquer código de serviço/parser/frontend; aplicar em produção; merge; deploy; rollout legado.
