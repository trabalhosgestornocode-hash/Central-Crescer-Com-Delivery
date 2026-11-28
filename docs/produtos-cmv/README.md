# Produtos / CMV 2.0: documentação técnica

> Sem dados de clientes. Os diagnósticos por empresa e as capturas com dados reais ficam fora do repositório.

## O que muda para todos (independe do módulo piloto)

1. **Paginação do grafo e dos carregadores.** O PostgREST devolve no máximo 1.000 linhas por resposta. `carregarGrafo` lia `ficha_tecnica` numa só consulta, então organizações com mais de 1.000 linhas de ficha tinham custos e diagnósticos calculados sobre um grafo **truncado em silêncio**. Agora `lerTudo()` pagina:
   - ordem total por coluna única;
   - `.in()` em blocos de 150 ids;
   - parada na primeira página incompleta.

   Isso vale também para insumos (`listarInsumos`), produtos (`listarProdutos`), margens (`vw_produto_margem`), pendências e origens da carga, mão de obra, verificação de código PDV e recálculo de cache (que passou a usar o `custo_manual` do grafo completo, em vez de `.in()` com centenas de ids).
2. **Critério único de integridade para homologar.** A homologação antiga (individual, em lote e o `pode_homologar` da lista) usa o mesmo motor da experiência nova (`integridade.js` → `diagnostico.js`). Ela bloqueia:
   - preparação comprometida em qualquer nível;
   - insumo sem custo;
   - rendimento em unidade suspeita;
   - unidade de rendimento ausente;
   - ciclo;
   - pendências abertas da carga.

   O bloqueio vale para qualquer caminho, inclusive chamadas diretas à API. Fichas padronizadas (`homologacao = 'nao_aplicavel'`, franquia) mantêm as regras próprias. Homologações antigas que hoje não passariam são **listadas** (`homologadas_inconsistentes`) e **nunca revogadas** automaticamente.
3. **Custo zero declarado** passa a ser custo válido no status da ficha (antigo e novo). Zero sem declaração continua "desconhecido".

## Experiência nova (módulo `products_cmv_v2`, ativação por empresa/unidade)

Visão geral, Produtos, Preparações, Insumos e embalagens, Central de pendências, Precificação, página da ficha (régua lote ÷ rendimento = custo unitário), assistente com rascunho e recuperação de ficha, revisão coletiva de rendimentos, custo zero declarado, preço oficial com histórico e homologação em lote com prévia.

Todas as rotas `/produtos/cmv/*` exigem o módulo (403 sem ele) e usam as mesmas permissões de antes:
- **leitura:** quem tem Produtos/CMV;
- **edição** (rascunho, preço, nova ficha): `produtos.editar`;
- **correções coletivas, custo zero e homologação:** `configuracoes.gerenciar`.

A organização vem sempre do contexto autenticado. Exceção da plataforma: a impersonação (SuperAdmin) ignora o gate de módulo, como já acontece hoje em todos os módulos.

Perfil de operação inferido dos **dados**, nunca do nome ou id:
- `franquia_padronizada` quando ≥ 90% das fichas são `nao_aplicavel`: sem assistente de receita, homologação ou revisão de rendimento;
- `marca_propria` nos demais casos;
- `sem_catalogo` quando a unidade está vazia.

`GET /produtos/cmv/mentoria` entrega indicadores consolidados (somente leitura) para uso futuro pelo Núcleo Mentorados.

## Motor (puro, testado)

- `insumos.calc.js`: `naturezaCusto` (informado / zero declarado / desconhecido), `lerNumeroBR` ("2.600" lido como milhar **e** marcado ambíguo), `dividirSeguro`.
- `diagnostico.js`: pendências com problema, impacto, correção e onde corrigir; causas-raiz com número de impactados; plausibilidade do rendimento (massa comparável dos componentes; nunca converte massa↔volume); ciclos; situação; elegibilidade; 5 dimensões (receita completa, custo confiável, preço comercial, CMV %, rentabilidade).
- `revisaoRendimento.js`: hipótese ×1000 só com fundamento (faixas de confiança), custo antes/depois, impacto nos dependentes, validação do lote.
- `aproveitamento.js`: fator de correção **derivado** de peso bruto/líquido (contradição recusada), aproveitamento, perda, índice de cocção, custo do aproveitável; recusa perda contada duas vezes (perda já no preço do insumo).
- `precificacao.js`: CMV, margem bruta, deduções do canal (reaproveita `cmv.condicoes.js`), margem de contribuição (não é lucro), preço para a meta de CMV e para a margem alvo. Nunca grava.
- `custoTotalProduto` / `fn_custo_produto` **não mudaram**: mesma metodologia; a franquia segue idêntica.

## Migration 163 (`database/migrations/163_produtos_cmv_governanca.sql`)

É aditiva, idempotente e transacional.
- **Colunas opcionais:**
  - em `insumos`: custo zero e aproveitamento;
  - em `ficha_tecnica`: pesos e índice de cocção;
  - em `produto_precos`: origem, vigência e responsável.
- **Tabelas novas:** `produto_precos_historico`, `produto_rascunhos` e `catalogo_correcoes`, com RLS ligado e sem grant para anon/authenticated.
- **Funções** `fn_corrigir_rendimentos` (tudo ou nada; recusa outra organização, ficha padronizada, valor alterado desde a prévia e falta de justificativa; o gatilho da 158 invalida as homologações dependentes) e `fn_custo_zero` (motivo obrigatório; revogar volta a "desconhecido"). Ambas `security definer`, sem execute para public.
- **Gatilho de compatibilidade:** um preço > 0 informado pela tela antiga de insumos encerra uma declaração de custo zero (auditado), em vez de falhar na constraint.
- **Seed** do módulo `products_cmv_v2` (nasce desligado para todas as empresas).
- **Locks:** `ADD COLUMN` com default constante (só metadado), CHECKs `NOT VALID` + `VALIDATE`, `lock_timeout 5s`.
- **Compatibilidade:** `fn_custo_produto` inalterada; o código publicado antes da 163 continua funcionando (colunas novas opcionais e ignoradas).
- **Rollback:** `163_rollback.sql` **recusa** a reversão se houver dados criados pelas funcionalidades novas (não apaga dado real). O desligamento operacional é remover o módulo `products_cmv_v2` da empresa/unidade.

## Testes

| Suíte | Onde |
|---|---|
| Motor puro (rendimento, conversões, aproveitamento, precificação, elegibilidade, recuperação, cascata, Subway) | `backend/test/produtos-diagnostico.test.js`, `produtos-cmv-2.test.js` |
| Paginação (999/1.000/1.001/2.000/2.501 linhas, banco falso com teto de 1.000), integridade na homologação antiga, isolamento, rotas com e sem o módulo, permissões | `backend/test/produtos-cmv-paginacao-integridade.test.js` |
| Migration em Postgres **descartável** (157 + 158 + 163, idempotência, isolamento, atomicidade, concorrência, gatilho, permissões, rollback, equivalência da franquia) | `backend/testes-seguros/catalogo-pg/run163.sh` |
| Navegador real (sem o módulo, a tela antiga não muda; fluxo completo; perfil consulta; unidade vazia; mobile 390 px) | `frontend/test/produtosCmv2.browser.test.js` |

Suítes que ficam **ignoradas por desenho** (dependem de recursos fora do repositório; não são falhas):
- `auditoria de catálogo — dinâmico`: Postgres local, `CHECKLIST_PERFIL_PG_URL`;
- `CARGA REAL` (2 testes): `CATALOGO_PAYLOAD` e `CATALOGO_RELATORIO`;
- `TABELAS REAIS`: `CATALOGO_TABELAS_DIR` e `CATALOGO_TABELAS_ORG`;
- capturas com retrato real: `CMV2_RETRATO` e `CMV2_SHOTS`.

## Ativação e rollback

1. Backup, depois a migration 163, depois o deploy. Sem o módulo, só valem a paginação e o critério único de integridade.
2. Habilitar `products_cmv_v2` por empresa (e unidade). A sessão guarda os módulos por até 8 h: a empresa passa a ver o módulo no próximo login ou na renovação do contexto.
3. Rollback em camadas:
   - remover o módulo da empresa;
   - reverter o merge (as rotas novas exigem o módulo; a 163 é compatível com o código anterior);
   - `163_rollback.sql`, somente sem dados criados.
