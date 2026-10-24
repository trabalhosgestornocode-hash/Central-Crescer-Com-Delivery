# Checklist Operacional 2.0 — homologação técnica do PR #53

> Executada em 24/10/2026 em **PostgreSQL 17.11 local e descartável** (binários oficiais EDB, cluster novo em pasta própria,
> só `127.0.0.1:55430`, sem serviço Windows, sem credencial nem dado de produção) e em **Chrome real** (Playwright).
> Nenhuma operação em produção, merge ou deploy.

## 1. Verificações preliminares

| Item | Resultado |
|---|---|
| PR #53 | aberto, Draft, `MERGEABLE`; `main` não avançou desde o rebase (0 commits à frente) |
| Numeração 127/128 | livre: a `main` vai até 126; o schema real base + 068..128 aplica com **0 falhas** |
| Efeito da régua "Etapa 2" no histórico | o Dashboard calcula **sob demanda a partir dos eventos brutos** (`ifood_pedidos`): não há agregado gravado a migrar nem número antigo a corrigir. Todo período, inclusive passado, é medido pela régua atual (preparo = chegada → despacho; só DELIVERY; retirada fora dos tempos). Cada pedido continua avaliado pela meta vigente **no recebimento**. Atenção de negócio: o preparo agora inclui a espera pelo despacho — a referência p75 da `main` é 16,3 min contra o exemplo de 12 min; as unidades devem calibrar as metas antes de usar o "% dentro da meta" |
| Falhas do backend × `main` | os 9 arquivos que falham foram rodados nas duas árvores (checkout LF): **lista de testes falhos idêntica** (16 nomes, incluindo 1 intermitente que apareceu nas duas) — comunicação/central de conversas, frota, financeiro/dominio, sessão/perfil, whatsapp-retry (dependências do gateway) e a pendência intencional de Novos Clientes (**não alterada**) |
| Suítes `*-pg` (todas) | PR: 228 testes, 227 ok; `main`: 199, 198 ok. **Mesma única falha nas duas**: o perfil de exibição recebe 200 em `GET /sessao/setores` (módulo de sessão, fora deste PR — achado pré-existente, registrado em §5). Todas as rotas novas do PR são negadas a esse perfil |

## 2. Homologação PostgreSQL

| Validação | Resultado |
|---|---|
| `checklist-metas-migration-pg.test.js` | **6/6** (2 rodadas) |
| `checklist-metas-migration-recuperacao-pg.test.js` (novo) | **9/9** (2 rodadas) |
| 127 em transação | aplica; reaplicar é idempotente |
| 127 sob lock (lock_timeout 5 s) | **aborta inteira**: nenhuma tabela, função ou gatilho órfão; aplica normalmente depois |
| 128 dentro de transação | recusada pelo Postgres (`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`); nada criado |
| 128 fora de transação | índice criado com 3 000 pedidos existentes; `indisvalid` e `indisready` verdadeiros; definição exata conferida |
| Índice em uso | o plano da consulta do Dashboard (tenant + intervalo de `criado_em`) usa `idx_ifood_pedidos_tenant_criado` |
| Falha no meio do CONCURRENTLY | índice INVALID: **reaplicar a 128 não conserta** (`IF NOT EXISTS`); `drop index concurrently` + reaplicar conserta — procedimento já escrito no cabeçalho da 128 |
| Estrutura | PK, 2 FKs com `on delete cascade`, 8 CHECKs (versão, 3 metas, 3 avisos, tamanho do nome), unicidade (unidade, versão) do histórico, gatilhos de tenant e de imutabilidade, índice do histórico |
| RLS e permissões | RLS ligada, 0 policies; anon/authenticated sem privilégio; service_role só `select` + `execute` da função de escrita |
| Concorrência real | duas gravações com a mesma versão: exatamente uma vence |
| Isolamento | unidade de outra organização recusada no banco; histórico não aceita UPDATE/DELETE; valores fora da faixa recusados |

## 3. Homologação funcional (cadeia real: `createApp` + autenticação + contexto + permissões, schema real 068..128)

`checklist-operacional-2-homologacao-real-pg.test.js` (novo): **14/14** em duas rodadas. Duas empresas, três unidades,
papéis reais (admin, gestora, operação, consulta, exibição) e várias sessões abertas ao mesmo tempo.

| Validação | Evidência |
|---|---|
| Alteração e propagação | a gestora salva (v0→v1); a TV (perfil de exibição), outra sessão (tablet) e o Dashboard passam a ver a v1; linha + histórico no banco; **um** Broadcast, só em `unidade:<id>`, tipo `checklist_metas.atualizadas`, sem valores |
| Conflito | duas sessões com a v1 ao mesmo tempo: 200 + 409 `METAS_CONFLITO` com o valor atual; quem perdeu salva de novo (v3); mesmos valores = `sem_alteracao` |
| Permissões | salvar e histórico: admin e gestora sim; operação, consulta e exibição 403 (nada muda no banco). Dashboard/Excel: todos os papéis de leitura; exibição 403 (e só o `/resumo` responde a ela) |
| Isolamento | Empresa B não vê as metas da A; ids de outra unidade no corpo são ignorados; A2 tem metas próprias; o Dashboard da A1 não conta pedidos de A2 nem de B1 |
| Indicadores | preparos 8, 10, 14, 9, 30 → média 14,2, mediana 10, P90 23,6; retirada fora dos tempos; meta vigente no recebimento (10 min: dentro da v1 = 12, fora da v2 = 8); comparativo 7 dias antes (mediana 10 × 20) |
| Verde/amarelo/vermelho | pedido em andamento há 6 min com a meta salva 30 / 7 / 4 → `ok` / `atencao` / `critico`, com a lógica da tela sobre a resposta real |
| Dashboard × PDF × Excel | mesmo filtro: abas e números do Excel (backend) e do PDF (frontend) iguais ao payload exibido |
| Queda e retomada | o resumo é sem estado: depois de alteração durante a queda, a próxima consulta traz a versão atual; sessão com versão velha recebe 409 e o valor atual |

**Navegador real** (`checklistOperacionalUniversal.browser.test.js`, +6 testes; 13/13 em duas rodadas):
Tablet salva → TV atualiza pelo polling; terceiro aparelho salva → TV atualiza pelo aviso do Realtime em 2 s (aviso de
outra unidade ignorado); conflito no diálogo mostra o aviso e carrega o valor do servidor; falha de gravação (503) mostra o
aviso e mantém a meta anterior, e grava quando volta; fundo verde/amarelo/vermelho com 3 cores distintas, ícone e texto,
TV 1280×720 sem rolagem; movimento reduzido sem transição; Dashboard aberto recarrega (1 vez, respeitando 15 s) quando as
metas mudam. Regressão: `checklistOperacionalModos` 40/40 e `perfilExibicao` 11/11, duas rodadas cada.
Unitários: frontend 1598 (0 falhas); backend do escopo 283/283.

## 4. Rollback (ensaiado)

Ordem **128 → 127**, com dados: o rollback da 128 só remove o índice (3 000 pedidos intactos); o da 127 remove tabelas,
funções e gatilhos — **as metas e todo o histórico de alterações são perdidos** (exportar antes:
`copy (select * from checklist_metas_historico order by unidade_id, versao) to stdout with csv header`). Pedidos,
migration 123 e Financeiro intactos. Os dois rollbacks são idempotentes; reaplicar 127 + 128 depois volta do zero
(versão 1). Depois do rollback da 127 o backend segue no ar: metas "indisponíveis" na tela e PUT 503.

## 5. Falhas encontradas e correções

| Achado | Onde | Correção |
|---|---|---|
| RPC que devolve tabela quebrava no PostgREST falso dos testes (`set-returning functions are not allowed in COALESCE`) | helper de teste | o helper passa a chamar `FROM função()` e devolver array, como o PostgREST real; RPC escalar inalterada |
| `.range()` (offset) ignorado no PostgREST falso | helper de teste | suporte a `offset` |
| Perfil de exibição recebe 200 em `GET /sessao/setores` | módulo de sessão (**fora do PR**, igual na `main`) | **não corrigido** (regra de outro módulo); recomendo avaliar em PR próprio |
| Nenhum defeito no código do PR | — | — |

## 6. Riscos remanescentes

1. Ensaio feito em PostgreSQL 17 local; o Supabase de produção pode ter versão/extensões e carga diferentes — aplicar
   primeiro num ambiente de testes do Supabase, em janela, com backup.
2. `CREATE INDEX CONCURRENTLY` em produção: se falhar, o índice fica INVALID e é preciso o procedimento de §2.
3. Rollback da 127 apaga o histórico de metas (exportar antes).
4. Metas precisam ser calibradas na régua nova (preparo inclui a espera do despacho) antes de se confiar no "% dentro da meta".
5. Binários EDB em zip não são assinados digitalmente (o instalador é); origem oficial por HTTPS, SHA-256
   `6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3`.
6. Testes de navegador do projeto que dependem de relógio real seguem intermitentes também na `main`.

## 7. Recomendação

**GO para seguir à homologação em ambiente de testes do Supabase** e, depois dela, à publicação controlada (ordem do
relatório de entrega §7). **NO-GO para aplicar direto em produção** antes desse ensaio no Supabase de testes — não por
defeito encontrado, mas porque o banco real de produção ainda não foi exercitado.
