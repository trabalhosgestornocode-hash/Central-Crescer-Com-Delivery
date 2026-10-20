# Classificação das falhas de teste do backend (2026-10-17)

**Método.** Cada arquivo foi executado em 3 condições, sempre com ambiente fictício (sem `backend/.env`):
(a) `main` sem `--experimental-vm-modules`; (b) `main` com a flag (o que `npm test` usa); (c) esta branch sob o T1 (`npm run test:seguro`).
Comparar (a)×(b)×(c) separa falha **ambiental** de **regressão**. Script: o mesmo da seção "Reprodução".

## Resumo
| Execução | Testes | Passaram | Falharam | Pulados |
|---|---|---|---|---|
| Primeira rodada (sem a flag do vm, fora do T1) | 5174 | 5132 | 17 | 25 |
| **T1 final desta branch** (flag + guarda) | 5321 | 5292 | 4 (3 arquivos/casos) | 25 |
| Violações de isolamento no T1 final | — | — | **0** | — |

As 17 da primeira rodada = 4 causadas por mim (guardas estáticas, **corrigidas**) + 13 que já existiam. As 13 se explicam assim:

## As 13 falhas "também observadas na main" (12 casos; `selecionarPerfil` conta 2 subtestes)
| # | Arquivo | Causa | Tipo | Evidência |
|---|---|---|---|---|
| 1 | `bonificacao-importacao-diaria.test.js` | O teste carrega módulos com `vm.SourceTextModule`, que exige `--experimental-vm-modules`. A primeira rodada rodou sem a flag. | **Ambiental (flag ausente)** | main sem flag 0/1 → main com flag **8/8** → T1 8/8 |
| 2 | `dashboard-executivo-metas-dinamicas.test.js` | idem | Ambiental | 0/1 → **30/30** → 30/30 |
| 3 | `dashboard-executivo-periodo-misto.test.js` | idem; **além disso** crashou 1× na suíte completa com `exitCode 3221225477` (0xC0000005, violação de acesso do próprio Node no Windows com a flag experimental). Sozinho passa 40/40 em todas as execuções. | Ambiental + **intermitente** (crash do processo) | 0/1 → 40/40 → 40/40; crash isolado na suíte cheia |
| 4 | `dashboard-executivo-protecao-consistencia.test.js` | flag do vm | Ambiental | 0/1 → 6/6 → 6/6 |
| 5 | `dashboard-executivo-rentabilidade-service.test.js` | flag do vm | Ambiental | 0/1 → 1/1 → 1/1 |
| 6 | `dashboard-executivo-tabelas-oficiais.test.js` | flag do vm | Ambiental | 0/1 → 4/4 → 4/4 |
| 7 | `modelo-logistico-temporal.test.js` | flag do vm | Ambiental | 0/1 → 32/32 → 32/32 |
| 8 | `parser-food-delivery-periodo.test.js` | flag do vm | Ambiental | 0/1 → 29/29 → 29/29 |
| 9–10 | `whatsapp-retry-allowlist.test.js`, `whatsapp-retry-cache-routes.test.js` | importam `gateway-whatsapp/node_modules/baileys`, que **não existe em worktree novo**. Instalado com `npm ci --ignore-scripts` em `gateway-whatsapp/`, passam. | Ambiental (dependência não instalada) | sem deps: `ERR_MODULE_NOT_FOUND`; com deps: 14/14 e 14/14 |
| 11 | `sessao-perfil.test.js` → "selecionarPerfil (Fase C)" (2 subtestes) | Os subtestes fazem `fetch` real ao Supabase; com URL fictícia dá `TypeError: fetch failed`. Exigem banco/Auth real de teste. | **Depende de T3** (Supabase descartável) — idêntico na main | 33/35 em (a), (b) e (c); `fetch failed` |
| 12 | `performance-calc.test.js` → "novos clientes seguem regra oficial" | Pendência **conhecida e independente**: `15d0482` passou a usar distribuição mensal como fallback em `novosClientesAcumulados`; o teste manteve a expectativa antiga. **Não alterado** nesta missão. | **Pendência de negócio (não é ambiente)** | 6/7 em (a), (b) e (c) |

> Ao reexecutar com a flag, **11 das 13** passam: o que sobra de verdade é **#11 (precisa de T3)**, **#12 (pendência de negócio)** e o **crash intermitente do Node em #3**.

## As 4 causadas por esta branch (corrigidas)
| Teste | Motivo | Correção |
|---|---|---|
| `central-acesso-painel` (guarda estática) | proibia o prefixo `exigirPermissao`; meu helper se chamava `exigirPermissaoFinanceira` | helper renomeado para `autorizarAcaoFinanceira` |
| `comunicacao-arquitetura-agendamento` (088) e `ifood-migration-103` | listas fechadas de migrations "posteriores conhecidas" | 120 acrescentada às duas listas |
| `perfil-exibicao-isolamento` (matriz de rotas do tenant) | todo router novo precisa estar em `MONTAGENS_TENANT` | `/gestao-financeira` registrado |

## Falhas induzidas pelo T1 durante o desenvolvimento (corrigidas na guarda, não nos testes)
| Teste | Sintoma sob o T1 | Causa | Ajuste |
|---|---|---|---|
| `comunicacao-classificacao-envio` | RETRYAVEL esperado, recebia INCERTO | testes usam host `*.invalid` e `http:///internal…` (nome de 1 rótulo) para simular DNS que não resolve | a guarda **simula localmente** `ENOTFOUND` para `.invalid` e nomes sem ponto (sem consulta DNS real); nomes com ponto continuam bloqueados |
| `ifood-financial-fixture-config`, `ifood-financial-homologation-units`, `ifood-events-embedded`, `efeitos-externos-guarda` | filhos perdiam variáveis | a guarda reimpunha o ambiente e descartava o que o **teste declarava** de propósito (ex.: URL de produção fictícia para provar que a configuração a recusa) | o env **declarado pelo teste prevalece** (literais públicos); a proteção é o raiz construído do zero + rede/subprocessos/`.env` bloqueados em todo filho |

## O que NÃO foi feito
- Nenhuma regra operacional foi alterada para "verdear" a suíte; a regra de Novos Clientes (Central de Performance) está intocada.
- `sessao-perfil` só passará quando houver Supabase de teste (T3).

## Reprodução
```bash
# baseline (main) sem/com flag, e T1:
node --test test/<arquivo>.test.js
node --experimental-vm-modules --test test/<arquivo>.test.js
npm run test:seguro -- test/<arquivo>.test.js     # a partir de backend/ na branch
```
