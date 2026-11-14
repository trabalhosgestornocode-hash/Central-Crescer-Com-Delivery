# Financeiro v2 — Execução 01 · Diagnóstico do ambiente e estratégia de isolamento

Data: 12/11/2026 · Branch: `feat/financeiro-v2-fundacao` (local, a partir de `main` @ `c214243`)

> **Nome.** O repositório já contém um módulo chamado internamente "Financeiro 2.0" (`gestao-financeira`, tabelas
> `fin_*`, funções `fin2_*`, flag `FINANCEIRO_2_ORGANIZACOES`, migrations `151`–`156`). Para não haver ambiguidade,
> o projeto novo usa em código e documentação o nome **Financeiro v2** (`financeiro-v2`, ações `financeiro_v2.*`,
> prefixo de tabela proposto `fv2_`). Neste documento, "financeiro antigo" = o módulo `gestao-financeira` atual.

## 1. Ambiente identificado

| Item | Encontrado |
|---|---|
| Repositório | `Central-Crescer-Com-Delivery` (GitHub, **visibilidade PÚBLICA**), monorepo |
| Estado do Git | `main` limpa em arquivos rastreados; ~25 caminhos não rastreados de outros trabalhos (preservados, não tocados); 20 worktrees de outras frentes |
| Backend | Node.js ≥ 20.12 (local: 20.19), ESM puro, Express 4, sem TypeScript, sem ORM; contratos por JSDoc |
| Frontend | JavaScript puro servido estático (`frontend/src`), sem framework; financeiro antigo em `frontend/src/financeiro/` (≈ 30 telas) |
| Banco | PostgreSQL no Supabase, acessado por `@supabase/supabase-js` com chave de serviço e por RPCs |
| Migrações | SQL numerado em `database/migrations/` (até `161`), com arquivo de rollback por migration; aplicadas manualmente (psql / operador). Não há ferramenta de migração nem banco local automático |
| Autenticação | JWT do Supabase validado em `backend/src/middlewares/auth.js` → `req.user`; contexto de trabalho por *Context Token* → `req.tenant = { organizacaoId, unidadeId }` |
| Empresas e unidades | `organizacoes` → `unidades`; módulos habilitados por `organizacao_modulos` e `unidade_modulos` |
| Permissões | Catálogo geral em `shared/permissoes.js` (papéis). O financeiro antigo tem catálogo próprio (`gestao_financeira.*`) concedido por unidade em `gestao_financeira_concessoes`, relido a cada requisição pelo gate `middlewares/financeiro.js` (sem bypass de impersonação) |
| Testes | `node:test` nativo; 401 arquivos em `backend/test/`; suíte do financeiro antigo em `backend/test/financeiro/` (209 testes); testes com Postgres descartável em `backend/testes-seguros/` |
| Deploy | Render (`render.yaml`) + Vercel; `backend/.env` local aponta para **produção** |

## 2. Financeiro existente e suas dependências

- Backend: `backend/src/modules/gestao-financeira/` (≈ 30 arquivos em `dominio/`), montado em `/gestao-financeira`
  atrás de `requireFinanceiro()`. Também há leitura financeira em `administrativo`, `plataforma`, `dashboard-executivo`,
  `ifood` (Financial) e `parser-food-delivery`.
- Dinheiro: valores `numeric` no banco e `Number` com casas decimais no JavaScript; há 153 ocorrências de
  `toFixed`/`Math.round`/"centavos" espalhadas por 24 arquivos do domínio — o arredondamento é decidido em cada serviço.
- Indicadores: Painel, DRE, Visão Geral e relatórios têm serviços próprios (`painel.service`, `relatorios.service`,
  `vendasCanal.service`, `f152.service`…), cada um com suas somas. É a origem estrutural das divergências entre relatórios.
- Vendas: tabelas e RPCs acumularam correções sucessivas (migrations 151–156) para pagamento × despesa, transferência
  múltipla e conciliação 1:N.

## 3. Riscos de acoplamento

| Risco | Consequência | Tratamento na fundação |
|---|---|---|
| Reaproveitar tabelas `fin_*` ou RPCs `fin2_*` | Herdar a modelagem que mistura fato econômico e pagamento | O v2 não lê nem escreve nada do antigo; guarda estática proíbe qualquer referência |
| Reaproveitar o catálogo `gestao_financeira.*` | Quem tem acesso ao antigo ganharia acesso ao novo sem decisão | Catálogo próprio `financeiro_v2.*`; permissões desconhecidas são descartadas |
| Importar utilitários de dinheiro do antigo | Trazer ponto flutuante para dentro do núcleo | Módulo de dinheiro próprio, em centavos inteiros |
| Compartilhar o registro de migrations | Migration nova quebra testes-guarda de outras frentes (3 allowlists) e pode ser aplicada por engano | **Nenhuma migration criada nesta execução** |
| `backend/.env` = produção | Qualquer teste com banco real escreveria em produção | Fundação 100 % sem banco; testes não carregam `.env` |
| Repositório público | Valores reais em commit ficam públicos ao primeiro push | Testes só com dados sintéticos; `02-referencia-setembro.md` **não foi commitado** (ver §7) |

## 4. Decisão: módulo isolado dentro do backend existente

Alternativas avaliadas:

1. **Serviço independente** (outro processo/repositório). Isolamento máximo, mas duplicaria autenticação, contexto de
   organização/unidade, deploy e observabilidade que já são confiáveis — custo alto e nenhum ganho de correção financeira.
2. **Evoluir o `gestao-financeira`**. Menor esforço inicial, mas mantém a modelagem e os cálculos que geraram as divergências.
3. **Módulo novo e isolado no mesmo backend** — **adotada**. Reutiliza apenas a *infraestrutura* confiável (sessão,
   contexto, gate por unidade), por meio de um adaptador fino a ser escrito quando houver rota; o núcleo financeiro não
   importa nada de fora da própria pasta.

Justificativa: o problema do financeiro antigo é de **modelo e de regra**, não de infraestrutura. Isolar o domínio e
manter a infraestrutura dá independência de cálculo sem criar um segundo sistema para operar.

## 5. Estrutura criada

```
backend/src/modules/financeiro-v2/
  index.js                    superfície pública
  dominio/                    regras puras (sem E/S, sem dependência externa)
    dinheiro.js   tempo.js   catalogos.js   contexto.js   validacao.js
    titulos.js    fechamento.js   indicadores.js   erros.js
  contratos/
    comandos.js               contratos de entrada (validação estrita)
    repositorio.js            PORTA de persistência (sem exclusão)
  aplicacao/                  operações atômicas sobre a porta
    nucleo.js  base.js  economico.js  caixa.js  documentos.js  conciliacao.js  competencias.js
  infra/
    repositorioMemoria.js     adaptador em memória (testes e referência de comportamento)
backend/test/financeiro-v2/   63 testes, dados sintéticos
docs/financeiro-v2/           esta documentação
```

Regras de dependência (verificadas por teste estático): `dominio` não importa `aplicacao` nem `infra`; nenhum arquivo
importa algo fora da pasta (exceto `node:crypto`); nenhum arquivo lê ambiente, rede, banco ou HTTP; o módulo não está
montado em rota e nenhum outro módulo o importa.

## 6. Decisões arquiteturais

| # | Decisão | Motivo |
|---|---|---|
| D1 | Dinheiro = inteiro de centavos; texto decimal convertido por dígitos; divisões em `BigInt` | Elimina erro de ponto flutuante; soma e rateio exatos |
| D2 | Arredondamento padrão "metade para cima"; "metade par" disponível por parâmetro explícito | Prática comercial; nenhuma regra arredonda por conta própria |
| D3 | Fato econômico (lançamento) separado de dinheiro (movimentação); a ligação é a liquidação | Pagar não cria segunda despesa; receber não cria segunda receita |
| D4 | Stone, iFood, vales e máquinas de terceiros são **processadores** (geram recebíveis), nunca contas | Saldo bancário só existe em conta bancária e caixa físico |
| D5 | Canal, forma de pagamento e processador são três catálogos independentes | Uma venda: um canal, várias formas, cada forma com seu processador |
| D6 | Só sistemas de origem de venda (PDV, iFood, Anota AI, manual) criam venda; relatórios de processador e extratos entram por conciliação | A mesma venda vista no SAIPOS e na Stone não vira duas |
| D7 | Idempotência por origem externa: mesmo conteúdo devolve o registro existente; conteúdo diferente é conflito | Reimportar não duplica nem sobrescreve em silêncio |
| D8 | Porta de persistência sem exclusão; alteração sempre versionada com antes/depois, autor, data e justificativa | Rastreabilidade total; cancelamento e estorno são estados |
| D9 | Contexto (organização, unidade, usuário, permissões) vem da sessão, nunca da entrada; contratos recusam campos desconhecidos | Isolamento entre empresas por construção |
| D10 | Lista explícita de escopos autorizados na montagem do núcleo; lista vazia impede a criação | Só a operação autorizada (Açaí no Grau Saci) opera; identificadores reais ficam em configuração, não no código |
| D11 | Indicadores definidos em um único lugar e sempre devolvidos com a composição | DRE e Visão Geral não poderão ter fórmulas divergentes |
| D12 | Competência homologada recusa toda escrita; reabrir exige permissão própria e justificativa | Sem alteração silenciosa de mês fechado |

## 7. Restrições encontradas

1. **Não há banco de teste isolado disponível nesta execução** e `backend/.env` é produção. Por isso a persistência
   definitiva (PostgreSQL) **não foi implementada**: existe a porta e um adaptador em memória. Ver pendências em
   `03-modelo-e-invariantes.md` §7.
2. **Repositório público.** `02-referencia-setembro.md` contém totais reais de setembro/2026; foi criado no disco,
   mas **não entrou no commit**. Decisão do responsável: mantê-lo fora do Git, ou movê-lo para local privado.
3. Os identificadores reais (organização/unidade do Açaí no Grau Saci) não foram consultados nem gravados no código.
4. Sem TypeScript no projeto: os contratos são validadores em tempo de execução + JSDoc, seguindo o padrão do repositório.
5. A suíte completa do backend tem falhas conhecidas de ambiente, anteriores a este trabalho; a regressão foi medida
   na suíte financeira (antiga + nova), com variáveis de ambiente fictícias.
