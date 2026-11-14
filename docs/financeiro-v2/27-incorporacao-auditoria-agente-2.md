# Financeiro v2 — 27. Incorporação da auditoria do Agente 2 (A-1/A5, A-2, L-1, P-1)

Data: 14/11/2026. Branch local `feat/financeiro-v2-incorporacao-auditoria`, worktree `C:\dev\fv2-agente1-auditoria`,
**rebaseada sobre `f34f90a`** (ponta atual de `feat/financeiro-v2-producao`). **Nada publicado; nada aplicado no
Supabase; nenhuma consulta nova à produção.**

Por que um worktree próprio: a sessão que conduz a Etapa C continua ativa na pasta principal (commit `f34f90a` às
16:08). Para não haver dois escritores nos mesmos arquivos, esta incorporação foi feita à parte. Ela entra na branch de
produção como avanço linear: os 5 commits ficam em cima de `f34f90a`.

## 1. O que foi aproveitado do Agente 2

| Commit (rebaseado) | Origem | Conteúdo |
|---|---|---|
| `9c9f004` | Agente 2 `3002562` | `scripts/fv2/auditoriaSupabaseAgente2.mjs` (auditoria independente; ampliada aqui com S4/S5 sobre o `instalar.sql` real) |
| `8ad7a96` | Agente 2 `2b964ee` | relatório `apoio-producao-agente-2.md` + gerador de desempenho seguindo a regra F-1 (P-1) |
| `879f99a` | adaptação | A5 + pré-condição A-2 + pós-condições no pacote de produção (`pacoteProducao.mjs` → `instalar.sql`) |
| `3ccadb1` | adaptação | teste do pacote exige A-2, A5 e as pós-condições novas |
| `8e4deb8` | adaptação | L-1: testes de setores com perfis sintéticos + plano 24b corrigido (ponto de contato, pré-condição da F5, D-24b-6) |

## 2. A-1 / A5 — privilégios padrão

- **Projeto real** (inspeção só-leitura do doc 25): privilégios padrão **só por schema**, nenhum global. O cenário
  hostil não ocorre hoje, mas a instalação não depende mais disso.
- **`instalar.sql`, depois da última migração (A5):** com participação temporária no guardião, desfeita na sequência,
  `revoke all on all tables|sequences|functions in schema financeiro_v2` de `anon`, `authenticated`, `service_role` e
  `authenticator`.
- **Pós-condições novas, que abortam a transação inteira:**
  - qualquer privilégio de PUBLIC ou de credencial comum em tabela ou sequência;
  - qualquer EXECUTE concedido a credencial comum;
  - qualquer tabela `fv2_*` em publicação.
- Não confia só no USAGE do schema.
- **Validação real** (`auditoriaSupabaseAgente2.mjs`, cenário S4: `instalar.sql` inteiro como `postgres` não
  superusuário, com padrões globais hostis): instala; K1a–K2c e K4–K6 OK; os 13 ataques SQL diretos continuam
  bloqueados.
- **Dois pontos em ATENÇÃO, inalcançáveis sem USAGE:**
  - K2b: EXECUTE herdado via PUBLIC em funções comuns.
  - K3: objeto criado *depois*, fora do pacote, herdaria padrões globais. Todo pacote gerado reaplica a A5.
- A validação real pegou um erro meu antes de chegar à produção: `acldefault` exige o tipo `"char"`, e o `instalar.sql`
  teria falhado inteiro.
- A sonda E4 do doc 25 continua OK com o pacote novo: foto do sistema atual idêntica, reinstalar recusado, desativar
  preserva tudo.

## 3. A-2 — replicação (metadados)

- **Não consultei a produção**: não há, nesta conversa, autorização explícita para novas consultas. A inspeção do
  doc 25 não incluiu publicações.
- **Proteção automática:** a pré-condição do `instalar.sql` **aborta antes de qualquer alteração** se existir
  publicação `FOR ALL TABLES`, com o nome dela na mensagem. Validado no cenário S5: nenhum schema e nenhum papel criado.
- Pós-condição: nenhuma tabela do v2 em `pg_publication_tables`.
- **Consulta só-leitura a autorizar** (para saber ANTES):
  `select pubname, puballtables from pg_publication; select pubname, schemaname, count(*) from pg_publication_tables group by 1, 2;`
- **Se der `FOR ALL TABLES`:**
  - a instalação para sozinha;
  - converter a publicação para lista explícita é mudança global da plataforma e exige avaliação de impacto no
    Realtime e autorização específica;
  - quem tem papel `postgres`/dono da publicação pode fazê-lo.

## 4. L-1 — setores e o legado

- `GET /api/v1/sessao/setores` lê `gestao_financeira_concessoes`, a única fonte de "somente financeiro". Por desenho,
  sem concessão vigente a restrição deixa de valer.
- É regra **de navegação**: nenhuma rota do backend a impõe, e as rotas operacionais seguem protegidas pelas
  permissões do perfil.
- As rotas novas do v2 **não** dependem da concessão antiga. O item de menu sim: setor "financeiro", decisão D-24b-1.
- **Testes** (`backend/test/financeiro-setores-legado.test.js`, 4 testes):
  - cinco perfis sintéticos: operador, gerente com financeiro, exclusivamente financeiro, TV da loja, impersonação;
  - o **risco fixado**: concessão revogada ou apagada devolve o setor operacional;
  - tabela ausente **falha fechado**;
  - um **alarme** que falha se a fonte mudar sem o 24b ser atualizado.
- **Plano 24b:**
  - L-1 nos pontos de contato;
  - a F5 passa a exigir fonte substituta e o aceite P17;
  - decisão nova **D-24b-6** (de onde vem "exclusivamente financeiro" depois do legado e se vale com a concessão
    revogada).
- Nada foi apagado.

## 5. P-1 — gerador de desempenho

Cluster próprio desta incorporação (`fv2-pg-teste-incorporacao`, porta 54399), migrado no schema dedicado.

| | 12 meses | 48 meses |
|---|---|---|
| Falhas de carga | 0 | 0 |
| Meses não fechados | 11, todos esperados (pré-vigência ou pendência bloqueante) | 47, todos esperados |
| Equivalência | 12/12 meses, 18/18 telas | 48/48 meses, 18/18 telas |
| Central de Conferências | 553 → 196 ms | 2139 → 250 ms |
| Caixa e bancos | 337 → 41 ms | 1189 → 42 ms |

Nenhum cálculo financeiro foi alterado. A regra F-1 não foi afrouxada.

## 6. Testes (comparados com a base certa)

| Suíte | Resultado |
|---|---|
| Financeiro v2 em memória | **400/400** |
| Financeiro v2 em PostgreSQL, **schema dedicado**, migrador sem superusuário | **400/400** |
| Pacote de produção | 5/5 |
| Setores e gate do legado | 28/28 |
| Frontend | 1951 passando, 0 falhas, 26 pulados |
| Auditoria Supabase simulado S1–S5 | § 2 e § 3 |
| Regressão do backend | 6449 testes, 18 falhas, 1 cancelado |

**Duas falhas a mais que a lista da 08D, conferidas:**
1. `matriz de isolamento — routers REAIS do tenant` vinha das rotas novas de `fbfb7f2`. Foi corrigida por `f34f90a`
   e passa depois do rebase.
2. `dashboard-executivo-periodo-misto` é **intermitente pré-existente**:
   - 2 falhas em 8 no HEAD, 1 em 8 em `0a99637`;
   - nem o código nem o teste mudaram entre as duas.

Todas as demais são as mesmas da 08D. MFA: os testes de MFA (`identidade-mfa-liberacao`, `integracao-http`) estão
dentro dos 400.
