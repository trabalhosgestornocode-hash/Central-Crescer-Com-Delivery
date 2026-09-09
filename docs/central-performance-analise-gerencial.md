# Central de Performance — camada de análise gerencial (etapa 2)

Continuação local de 09/09/2026 sobre a base já entregue em
`central-performance-fechamento-entrega.md`. Nada foi recriado do zero; o
trabalho anterior (auditoria, `performance.calc.js`, `performance.competencia.js`,
`performance.service.js`, migration 078, tela de Fechamento) foi preservado.

**Sem persistência nova.** Tendências, metas, status, diagnósticos e prioridades
são **derivados em runtime** a partir da evolução mensal consolidada. A migration
078 continua sendo apenas complementos.

## Arquivos

Novos:

- `backend/src/modules/administrativo/performance/performance.targets.js` — metas
  e limiares centralizados (única fonte; nada de "20"/"7"/"10" no controller ou no
  frontend). Override opcional por ambiente.
- `backend/src/modules/administrativo/performance/performance.analysis.js` — motor
  determinístico de análise: classificação de tendência, status por dimensão,
  metas, diagnósticos (evidência × hipótese), pontos de investigação, prioridades,
  resumo executivo, qualidade dos dados e comparação entre unidades.
- `backend/test/performance-analysis.test.js` — 21 cenários.
- `database/migrations/078_rollback.sql` — reversão da 078 (consistente com
  075/076/077), reexecutável.

Alterados:

- `backend/src/modules/administrativo/performance/performance.service.js` — o
  endpoint `GET /api/v1/administrativo/performance` passa a devolver a análise de
  forma **aditiva** (contrato antigo intacto).
- `frontend/src/performance.js` / `performance.css` — Visão gerencial reorganizada
  nas seções pedidas.
- `frontend/index.html` — `performance.css?v=2`.
- `frontend/test/performance.test.js` — cobertura das novas seções.
- `backend/test/performance-service.test.js` — 2 casos para o contrato ampliado.

## Metas centralizadas (`performance.targets.js`)

| Meta | Valor padrão | Ambiente |
|---|---|---|
| Conversão mínima | 20% | `PERFORMANCE_META_CONVERSAO` (fallback `PERFORMANCE_CONVERSAO_REFERENCIA`) |
| Crescimento mensal mínimo | 7% | `PERFORMANCE_META_CRESCIMENTO_MIN` |
| Crescimento mensal desejado | 10% | `PERFORMANCE_META_CRESCIMENTO_DESEJADO` |

Estrutura preparada para essas metas virem do Painel Administrativo depois; nesta
etapa ficam no backend.

### Limiares de tendência (documentados em `LIMIARES`)

Preferência sempre pela comparação histórica da própria unidade (1º × último mês,
mês a mês, sequência). Nenhum limiar de "mercado".

| Limiar | Valor | Uso |
|---|---|---|
| `quedaAcumuladaPct` | −5% | QUEDA de faturamento/pedidos |
| `quedaForteAcumuladaPct` | −20% | QUEDA FORTE (acumulada) |
| `quedaForteMensalPct` | −15% | QUEDA FORTE (último mês a mês) |
| `crescimentoAcumuladaPct` | +7% (= meta mínima) | CRESCIMENTO |
| `clientesQuedaAcumuladaPct` | −5% | novos clientes CAINDO |
| `margemPp` | 1,5 p.p. | MELHORANDO/DETERIORANDO da retenção após iFood |
| `custoIfoodPp` | 1,5 p.p. | custo iFood deteriorando |
| `custoDescolamentoPct` | 5 p.p. | (Δ% despesas − Δ% faturamento) que pressiona a margem |
| `custoDescolamentoFortePct` | 15 p.p. | escala custo iFood para CRÍTICO |
| `entregadoresAcompanharPp` | 0,5 p.p. | entregadores ACOMPANHAR |
| `entregadoresCorrecaoPp` | 2 p.p. | entregadores CORREÇÃO (com custo por pedido piorando) |
| `conversaoCriticaPp` | 5 p.p. | conversão CRÍTICO |
| `minPontos` | 2 | competências mínimas para classificar tendência |

## Classificações

| Dimensão | Estados |
|---|---|
| Faturamento | CRESCIMENTO · ESTÁVEL · QUEDA · QUEDA FORTE · SEM DADOS |
| Novos clientes | CRESCENDO · ESTÁVEL · CAINDO · SEM DADOS |
| Margem após iFood | MELHORANDO · ESTÁVEL · DETERIORANDO · SEM DADOS |
| Custos iFood | MELHORANDO · ESTÁVEL · DETERIORANDO · SEM DADOS |
| Entregadores (iFood e externo, **sempre separados**) | MANUTENÇÃO · ACOMPANHAR · CORREÇÃO · SEM DADOS |
| Conversão (vs meta 20%) | DENTRO DA META · ABAIXO DA META · SEM DADOS |
| Status por dimensão | SAUDÁVEL · ATENÇÃO · CRÍTICO · SEM DADOS |

## Regras de análise implementadas

- **Custos iFood**: R$, % sobre faturamento, variação das despesas × variação do
  faturamento, evolução do percentual. Detecta "despesas cresceram
  proporcionalmente mais rápido que o faturamento e pressionam a margem após iFood".
- **Margem após iFood**: `faturamento − despesas iFood`; retenção = após / faturamento
  × 100. Tendência sobre a sequência; sinaliza "deterioração contínua" quando
  estritamente decrescente. **Nunca chamado de "lucro real"** — a UI declara
  explicitamente que não contempla CMV, folha, aluguel, impostos, energia e demais
  despesas operacionais.
- **Faturamento**: variação mensal e acumulada do período; sequência de quedas;
  destaque de queda acumulada relevante.
- **Motor de causa provável** (só quando há queda): separa **evidência nos dados**
  de **hipótese que exige investigação**. Conclui "queda associada ao volume de
  pedidos, não ao ticket" (ou o contrário) apenas quando os números sustentam;
  associa a queda de novos clientes quando ela também cai. Quando os indicadores
  não explicam sozinhos, marca hipótese e abre **"Possíveis pontos para
  investigação"** (exposição no iFood, visitas ao cardápio, campanhas, frete,
  disponibilidade, cancelamentos, avaliações, tempo de preparo, concorrência) —
  sempre como hipóteses, nunca afirmando "perdeu ranking".
- **Novos clientes**: valor atual, mês anterior, variação, sequência, queda
  acumulada.
- **Conversão**: meta 20%, gap em p.p., por competência (nunca média entre meses
  sem denominador de visitas).
- **Meta de crescimento**: para o último mês com base, `atual × 1,07` e `× 1,10`,
  com diferença em R$ e percentual necessário.
- **Entregadores**: % sobre faturamento e custo por pedido, por fonte, por
  tendência histórica — nunca por um único mês, nunca somando iFood + externo. A
  Central aponta eficiência/custo; não recomenda demissão/redução de equipe/mudança
  operacional.
- **Prioridades**: derivadas da gravidade (CRÍTICO > ATENÇÃO) e de um peso por
  dimensão; lista não fixa.
- **Resumo executivo por unidade**: texto determinístico montado dos indicadores —
  **não hardcoded para Centro/Avenida**, sem IA.
- **Comparação entre unidades**: maior crescimento, maior queda, melhor retenção
  após iFood, maior custo iFood, melhor conversão, melhor evolução de clientes,
  maior demanda de atenção — cada item omitido quando a métrica está ausente.
- **Qualidade dos dados**: cobertura (completa/parcial/insuficiente) e confiança
  (alta/média/baixa). Cobertura insuficiente **suspende** classificações de
  tendência e diagnósticos fortes; mês parcial rebaixa a confiança e emite aviso
  ("financeiro oficial cobre somente até …").

## Contrato final de `GET /api/v1/administrativo/performance`

Aditivo — as chaves anteriores (`unidades`, `competencias`, `consolidado`,
`variacoes`, `competencias[].evolucao/indicadores/variacoes/diagnosticos`)
continuam presentes.

```
{
  unidades: [...],                 // (inalterado) unidades elegíveis
  inicio, fim,                     // (inalterado)
  periodo: { inicio, fim, meses },
  metas: { conversaoMinima, crescimentoMinimo, crescimentoDesejado },
  consolidado: { ...indicadores },
  variacoes: { ... },
  competencias: [
    {
      unidade, evolucao: [...], indicadores, variacoes, diagnosticos, // (inalterado)
      tendencias: { faturamento, clientes, margemAposIfood, custosIfood,
                    entregadores: { ifood, externos }, ticketMedio },
      status: { FATURAMENTO, CUSTOS_IFOOD, MARGEM_APOS_IFOOD, CLIENTES,
                CONVERSAO, ENTREGADORES },
      metas: { faturamento, conversao: { meta, porCompetencia, ultima },
               novosClientes, crescimento },
      prioridades: [ { ordem, dimensao, severidade, texto } ],
      diagnosticoGerencial: [ { dimensao, tipo: 'evidencia'|'hipotese', texto } ],
      investigacao: [ ... ],
      resumo: { prioridade, texto },
      analise: { ...tudo acima reunido... }
    }
  ],
  consolidadoAnalise: { ...analise da série consolidada... },
  comparativo: { disponivel, motivo?, destaques, observacoes: [...] },
  diagnosticoGeral: { porUnidade: [...], comparativo: [...] },
  qualidadeDados: { cobertura, confianca, competenciasComDados, ... }
}
```

## Frontend — Visão gerencial reorganizada

Sem página nova, sem emojis, mesma paleta premium. Ordem: cabeçalho + filtros →
**Resumo da Performance** (resumo + chips de status + prioridades por unidade) →
Indicadores do período → **Metas e Oportunidades** (conversão vs 20%, faturamento
+7%/+10% em R$, novos clientes, prioridade) → Evolução (Chart.js existente) →
Comparativo das unidades (observações gerenciais + tabela) → **Diagnóstico
gerencial** (Evidências × Hipóteses × Pontos para investigação) → **Entregadores**
(por fonte) → **Qualidade e completude** (cobertura/confiança + atalhos para o
Fechamento Mensal). Sem transbordamento horizontal em 375px.

## Pré-flight da migration 078

PostgreSQL real (PGlite 0.5.8 / PostgreSQL 18.3) fora do projeto
(`PERFORMANCE_PGLITE_PATH`). Banco descartável em memória. **Nenhum ambiente
persistente ou de produção foi tocado.**

- **Numeração/sequência**: `078_` é único; sucede `077_metas_logisticas_ajuste.sql`;
  não há outro `078_*` além do complemento e do rollback. Sem conflito.
- **Cadeia consolidada** (`000_base_migration.sql` + 068→078): aplica **OK**, 85
  tabelas. (O caminho "incremental" — `schema.sql` + 001→078 — falha em
  `005_saladas_e_faltantes.sql` por FK de *seed* de organização inexistente no
  PGlite; é limitação histórica do encadeamento, **anterior e alheia à 078**.)
- **FKs**: `organizacao_id → organizacoes(id)`; `criado_por/atualizado_por/
  fechado_por → perfis(id)`.
- **FK composta**: `(unidade_id, organizacao_id) → unidades(id, organizacao_id)`,
  apoiada pelo índice único novo `unidades_id_organizacao_performance_uidx`.
- **Índices**: PK em `id`; `UNIQUE (unidade_id, competencia)`;
  `(organizacao_id, competencia)`; o único de apoio em `unidades`.
- **Checks**: dinheiro `>= 0` e `<> NaN`; `conversao_manual` 0–100; inteiros
  `>= 0`; `competencia` = dia 1; `status ∈ {rascunho, fechado}`; `versao > 0`;
  consistência do fechamento (data + autor + hash de 64).
- **RLS**: habilitada; **0 policies** (sem acesso direto de cliente).
- **Grants**: `anon`/`authenticated` sem nenhum privilégio; `service_role` com
  `SELECT/INSERT/UPDATE` (sem `DELETE`/`TRUNCATE`).
- **Trigger/função**: `performance_complemento_versionar` presente; `SET
  search_path = public`; bloqueia troca de escopo, preserva criação, incrementa
  versão (CAS).
- **Rollback**: `078_rollback.sql` remove tabela, função, trigger e o índice de
  apoio; reexecutável; a 078 reaplica limpo em seguida.

## Etapa 3 — preparação para produção (validação estendida)

Só validação e organização; nenhuma funcionalidade nova. Único ajuste de código:
`frontend/src/performance.js` deixou de carregar `{7,10,20}` como fallback local —
os percentuais das metas vêm de `metas.faturamento.percentualNecessario*` do
próprio payload (reforço da regra "nenhuma constante de meta no frontend").

### Introspecção read-only da produção (`uqybgauuxcrqzquultfu`, PostgreSQL 17.6)

Somente `SELECT` / catálogo. Nenhuma escrita.

- `performance_mensal_complemento`, `unidades_id_organizacao_performance_uidx` e
  `performance_complemento_versionar` **ainda não existem** → 078 aplica limpo (a
  migration não é idempotente: `CREATE TABLE`/`FUNCTION`/`TRIGGER` sem
  `IF NOT EXISTS`/`OR REPLACE`; só o índice em `unidades` tem `IF NOT EXISTS`).
- `organizacoes(id)` PK, `perfis(id)` PK, `unidades(id)` PK, `unidades.organizacao_id`
  NOT NULL — todas as referências da 078 existem com a forma esperada.
- `unidades` **não tem** unique em `(id, organizacao_id)` → o índice que a 078 cria
  é necessário para a FK composta e não colide (`unidades_pkey`, `unidades_cnpj_key`,
  `idx_unidades_org`, `idx_unidades_eh_teste` são os índices atuais).
- `gen_random_uuid()` disponível.
- Produção hoje: 84 tabelas públicas, 82 policies — a cadeia consolidada no PGlite
  reproduz exatamente esses números antes da 078.
- **Dados reais das duas unidades** (config `PERFORMANCE_UNIDADE_IDS`):
  `1ef5aace-…a48` = "Matriz  Subway Centro Montes Claros" (org
  `074f6ba1-…e91`, `marketplace`); `aa1da7d9-…b6e` = "Matriz Subway Avenida
  Montes Claros" (org `0c7b9f50-…e52`, `marketplace`). Ambas ativas, não teste,
  organizações ativas e não modelo. Módulos: `ifood_dashboard` habilitado (→
  elegíveis); `parser_food_delivery` **não** habilitado (→ Parser fora, como manda
  a regra). `parser_fd_importacoes` para essas unidades: **0** (17 no schema, de
  outra unidade).
- **Cobertura oficial** (LFD, abr–ago/2026): abril/maio/junho **sem nenhuma
  linha**; julho = 31 fatias `distribuicao_mensal`, faturamento em todas, **sem
  pedidos/novos clientes**; agosto = 31 dias finalizados, **snapshot financeiro só
  nos dias 25–29** (parcial até 29/08), pedidos e novos clientes presentes.
  Nenhum lançamento em rascunho.
- **Conversão**: nenhuma coluna de conversão/visitas em todo o schema público
  (só `agente_*.conversa_id`, sem relação). Confirma "conversão sem fonte
  automática".

### Pré-flight sobre schema *production-accurate* (PGlite / PostgreSQL 18.3)

`scratchpad/preflight-078.mjs`: semeia `organizacoes`/`perfis`/`unidades` com os
enums e chaves reais da produção, aplica a 078 e roda **30 verificações** — todas
passaram: estrutura (20 colunas), 3 grupos de FK + FK composta, UNIQUE, os dois
índices, trigger + `search_path`, RLS, 0 policies, grants (anon/authenticated sem
nada; service_role SELECT/INSERT/UPDATE sem DELETE), 9 rejeições esperadas
(FK, FK composta, UNIQUE, checks de dia/percentual/dinheiro/NaN, imutabilidade do
escopo, consistência do fechamento), CAS de versão, bloqueio de leitura para
anon/authenticated, `rollback` completo + reexecutável + **reapply** limpo.

PGlite é o engine PostgreSQL 18; produção é 17.6 — a 078 não usa nada
específico de versão (FK/unique/check padrão, RLS, `REVOKE`/`GRANT`, plpgsql com
`SET search_path`, `gen_random_uuid`), estável de PG 13 a 18.

## Limitações atuais

- Conversão consolidada entre meses/unidades permanece indisponível sem
  denominador de visitas; a análise usa a evolução por competência.
- O "motor de causa" trabalha com os indicadores existentes (faturamento,
  despesas iFood, pedidos, ticket, novos clientes, conversão manual). Exposição no
  iFood, visitas ao cardápio, campanhas, frete, cancelamentos, avaliações e tempo
  de preparo não são dados do sistema hoje — entram como hipóteses.
- Abril–junho/2026 continuam sem fonte automática; a análise só ganha força quando
  há ≥ 2 competências com dados.
- `graphify` não está instalado neste ambiente; `graphify update .` não foi
  executado.
