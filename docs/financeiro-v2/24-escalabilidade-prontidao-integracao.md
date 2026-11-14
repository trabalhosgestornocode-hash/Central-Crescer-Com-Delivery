# Financeiro v2 — 24. Escalabilidade, validação da identidade e prontidão para homologação remota (Execução 09C)

Data: 14/11/2026. Branch local `feat/financeiro-v2-escalabilidade`, derivada de `2b07fe1` (09B).

> **Somente local.** Nenhum serviço remoto provisionado; nenhuma conexão a produção; `backend/.env` não lido; nenhum
> token, conta ou dado real; nenhuma migração fora do PostgreSQL isolado; sem push/merge/deploy. Dados sintéticos.

Matriz para decisão: [24a-matriz-pendencias-decisao.md](24a-matriz-pendencias-decisao.md) (gerada da 23a).
Substituição do financeiro antigo (atualização de escopo): [24b-substituicao-financeiro-antigo.md](24b-substituicao-financeiro-antigo.md).
Infraestrutura: **projeto Supabase existente, schema dedicado** (adendo; § 11).

---

## 1. Diagnóstico de desempenho (Fase A)

Reprodução da 09B no mesmo computador e gerador (`node scripts/fv2-desempenho.mjs <meses> 200`) e **perfil de CPU** da
execução de 12 meses (`node --cpu-prof`, 222 s de amostragem):

| Onde | Tempo próprio | Observação |
|---|---|---|
| Espera de E/S (banco) | 57,9% | o processo está esperando o PostgreSQL |
| Conversão de linhas `registroDe` (repositório PG) | 8,1% | cresce com o número de linhas lidas |
| Parser do driver `pg` (`parseRow`, `parseDataRowMessage`, buffers) | ~8% | idem |
| Congelamento profundo dos registros (`congelar`) | 1,8% | idem |
| Domínio de tesouraria (cálculo) | 1,3% | **as fórmulas são baratas** |
| Domínio de vendas e recebimentos | 2,7% | idem |

## 2. Causas comprovadas

1. **Caixa e Bancos, Visão Geral, Fluxo e Calendário compartilhavam UMA carga** (`carregarTesouraria`) que lia o
   histórico inteiro de títulos, liquidações, movimentações, propostas bancárias, documentos e vínculos, mesmo para
   mostrar um mês. O custo é transferir e converter linhas (perfil acima), não calcular.
2. **O saldo era reconstruído com todas as movimentações** desde a âncora, transferidas uma a uma, quando só a SOMA era
   necessária fora do período exibido.
3. **Contas a Receber sem filtro é, por definição, o histórico inteiro** (lista paginada e totais de todos os títulos,
   inclusive pagos; a interface abre com `soCompetencia` desligado). Com filtro de competência, ainda assim lia todos
   os recebíveis antes de filtrar.
4. **Carga em lotes de 200 ids** multiplica as consultas (Contas a Receber: 18 → 40 consultas de 3 para 12 meses).
5. **Latente (não exercitada pelo gerador, que não registra saldos):** `conferenciasDeSaldo` refiltra todas as
   movimentações da conta para CADA saldo informado — O(saldos × movimentos). Com saldo mensal, cresce ao quadrado.
   Os cenários da § 5 registram saldo todo mês para exercitar esse caminho.

## 3. Consultas otimizadas (Fases B e D)

| Consulta | Antes | Agora (mesmas funções de domínio) |
|---|---|---|
| Caixa e Bancos | histórico inteiro | movimentos **do período** + tudo o que eles referenciam; fora do período, **resumos diários somados no banco** (por conta, sentido e dia, só válidos: soma + quantidade) |
| Visão Geral (resumo) | histórico inteiro | movimentos do intervalo exibido (competência e hoje) + resumos diários; obrigações inteiras; recebíveis **só em aberto** + **contagem** dos não cancelados no banco |
| Contas a Receber com competência | todos os recebíveis | só os da competência (filtro no banco) |
| **Posição a receber no fim da competência** (nova) | não existia | candidatos lidos no banco: em aberto hoje, liquidados depois de D, ajustados depois de C |

Nenhuma fórmula foi duplicada no frontend nem alterada. O domínio ganhou só: contagens que somam a `quantidade` dos
resumos diários, e o resumo usa a contagem do banco quando fornecida. Valor desconhecido continua `null` (conta sem
âncora segue "saldo desconhecido").

**Posição a receber (`posicaoAReceberEm`)** — mesma conservação dos títulos, só com o que existia em D (último dia da
competência): recebíveis de competência ≤ C, cancelados fora (cancelamento é correção e só é permitido com a
competência aberta), esperado = base + ajustes de competência ≤ C, recebido = liquidações com data ≤ D menos estornos
com data ≤ D. Pagamento ou estorno de outubro não muda a posição de 30/09; título antigo ainda pendente aparece em toda
posição posterior; para D no presente, saldo na data = saldo gravado (testado).

## 4. Estratégia de saldos de referência (Fase C)

**Decisão: NÃO persistir saldos de referência calculados nesta execução.** Avaliação:
- Um saldo mensal gravado precisaria de invalidação a cada movimento retroativo, de versão por competência (homologada
  × reaberta) e de prova de integridade — com risco de usar referência velha como verdadeira.
- O ganho equivalente foi obtido **sem estado novo**: o banco **soma** as movimentações fora do período (resumos
  diários). O saldo continua matematicamente reproduzível a partir dos registros, movimento retroativo entra na soma
  na hora, competência reaberta não altera nada silenciosamente e não há duplicação.
- Referência mensal **não** é reconciliação bancária: a única âncora continua sendo o **saldo informado** (com
  documento e conferência), como desde a 06A/06B.
- Se o volume real exigir mais (milhares de movimentos por dia), o próximo passo seguro é uma tabela de **somas
  diárias materializadas no banco, mantida por gatilho** (sempre consistente com os movimentos) — avaliar com volume real.

## 5. Resultados de equivalência (Fase E)

Prova em dois níveis, comparando a carga dirigida com a **carga completa de referência** no mesmo repositório:
1. **Modo de conferência em toda a suíte** (`FV2_CONFERIR_CARGA=1`): cada consulta dirigida é recalculada com a carga
   completa e a igualdade é exigida — **388/388 aprovados** (memória + PostgreSQL isolado, `--test-concurrency=1`),
   inclusive o cenário de 48 meses.
2. **Cenários longos mês a mês** (`escalabilidade-equivalencia.test.js`): históricos de **1, 3, 12 e 48 meses** com
   recebíveis antigos ainda abertos (pagos pela metade), pagamento parcial e **agrupado**, liquidação posterior ao
   fechamento, **estorno** parcial de liquidação, **transferência** interna, conta de caixa sem saldo inicial
   conhecido, saldo informado todo mês (conferindo e, a cada 6 meses, divergente), movimento **retroativo**,
   competência **homologada** e outra **reaberta**, e uma **segunda unidade**. Para cada mês: Caixa e Bancos
   (consolidado e por conta), Contas a Receber da competência, Posição a receber e Visão Geral — `deepEqual` (valores,
   datas, estados, vínculos, documentos). Também um período que atravessa meses. Em memória e em PostgreSQL.

## 6. Tempos antes e depois

Gerador e computador da 09B (`node scripts/fv2-desempenho.mjs <meses> <vendas/dia>`, PostgreSQL isolado, mediana em
ms, nada mais rodando). **Atenção ao ruído:** a mesma máquina deu tempos até 2–3× maiores em rodadas anteriores desta
execução com o computador ocupado; por isso as conclusões usam (a) a comparação **dentro da mesma rodada** e (b) as
**linhas lidas**, que são determinísticas. A coluna 09B é a medição registrada na 09B (12 meses × 200).

| Tela | 09B 12×200 | 09C 12×200 | 09C 12×50 | 09C 48×50 | 48/12 |
|---|---|---|---|---|---|
| Apuração / DRE (mês) | 42 | 31 | 15 | 17 | 1,13× |
| Visão Geral (apuração + resumo) | 215 | 129 | 52 | 139 | 2,67× |
| Composição de um indicador | 40 | 26 | 15 | 29 | 1,93× |
| Contas a pagar (página) | 40 | 25 | 12 | 45 | 3,75× |
| Contas a receber (página) | 164 | 118 | 31 | 113 | 3,65× |
| Contas a receber (competência) — nova | — | 17 | 11 | 12 | 1,09× |
| Posição a receber (fim do mês) — nova | — | 86 | 23 | 81 | 3,52× |
| **Caixa e bancos (mês)** | **150** | **28** | 21 | 24 | **1,14×** |
| Vendas (página) | 173 | 123 | 59 | 98 | 1,66× |
| Central de Conferências | 190 | 130 | 64 | 89 | 1,39× |
| Fechamento (situação) | 188 | 132 | 64 | 86 | 1,34× |
| Prévia de homologação | 185 | 126 | 68 | 87 | 1,28× |
| 10 apurações simultâneas | 369 | 288 | 222 | 182 | 0,82× |
| 10 telas simultâneas (mistas) | 707 | 466 | 219 | 357 | 1,63× |

**Linhas lidas (consultas / linhas), carga dirigida:**

| Tela | carga completa 12×50 | 12×50 | 48×50 | 12×200 |
|---|---|---|---|---|
| Caixa e bancos (mês) | 19 / 3.085 | 21 / 306 | **21 / 774** | 21 / 493 |
| Contas a receber (competência) | 19 / 3.085 | 10 / 123 | **10 / 123** | 10 / 312 |
| Visão Geral (resumo) | 19 / 3.085 | 31 / 764 | 42 / 2.492 | 44 / 2.325 |
| Posição a receber (fim do mês) | 19 / 3.085 | 14 / 698 | 29 / 2.498 | 29 / 2.612 |
| Contas a pagar (página) | 19 / 3.085 | 10 / 254 | 13 / 830 | 13 / 794 |
| Contas a receber (página, sem filtro) | 19 / 3.085 | 18 / 1.069 | 40 / 4.165 | 40 / 4.195 |
| Fluxo de caixa (mês) | 19 / 3.085 | 19 / 1.561 | 25 / 6.097 | 24 / 5.637 |

Equivalência dirigida × completa: **IDÊNTICA** nas três rodadas (todas as telas medidas).

## 7. Crescimento com 48 meses

- **Planas (crescimento só com o volume do mês):** Caixa e Bancos (21 consultas sempre; 1,14×), Contas a Receber por
  competência (123 linhas em 12 e 48 meses), DRE.
- **Crescimento residual (documentado, não escondido):**
  - **Fluxo de caixa** ainda usa a carga ampla da tesouraria (6.097 linhas com 48 meses): é a próxima candidata aos
    resumos diários — **não otimizada nesta execução**.
  - **Contas a receber sem filtro** é o histórico inteiro **por definição** (a lista mostra todos os títulos); a
    interface deve abrir pela competência (consulta plana) — decisão de produto.
  - **Posição a receber** e **Visão Geral** leem os títulos **em aberto hoje** (inclusive antigos pagos pela metade,
    que o gerador acumula: ~1 a cada 4 meses) e suas liquidações; crescem com a quantidade de títulos pendentes, não com
    o histórico pago. **Contas a pagar** lê todas as obrigações (recorrências).
- Com 48 meses, nenhuma tela passou de 150 ms de mediana neste computador; 10 telas mistas simultâneas: 357 ms.
- **Veredito de desempenho:** adequado no volume sintético de 48 meses; os itens residuais acima ficam como pendência
  (não são PASS de escalabilidade ilimitada). A confirmação depende de volume real anonimizado (§ 14).

## 8. MFA e identidade (Fase F)

Revisão do contrato da 09B (`integracao/provaDeAutenticacao.js`) com tokens e identidades sintéticos:
- **O instante do segundo fator NÃO é o `iat`.** Um token renovado agora (iat recente) com o fator usado há 2 h é
  recusado; o instante vem do método de segundo fator em `amr` (teste "emissão do token NÃO é o instante do 2º fator").
- Assinatura, conta (`sub`), nível (`aal2`), recência (10 min), expiração, troca de identidade (token de outra conta;
  outra pessoa na mesma sessão), revogação/expiração da sessão da plataforma (token válido não a salva), impersonação,
  conta compartilhada e contexto de empresa/unidade (token válido não troca a unidade): testados.
- **O que AINDA precisa de autenticação real (num projeto descartável, nunca produção):**
  1. o provedor grava em `amr` um método de 2º fator (`totp`) com carimbo **em segundos** após `challenge`/`verify`;
  2. esse carimbo **é preservado** quando o token é renovado (refresh) — senão a recência some a cada renovação;
  3. um novo `challenge`/`verify` imediatamente antes da ação produz token com carimbo **atualizado**;
  4. a chave de verificação (JWKS assimétrica ou segredo) disponível ao gateway, e o comportamento após `signOut`.
- **Se o item 2 ou 3 falhar** (o contrato atual não pode provar recência), a alternativa segura é um **desafio
  explícito antes da ação**: a interface chama `mfa.challenge` + `mfa.verify` e envia o token recém-emitido; o gateway
  aceita só tokens com `iat` E carimbo de fator nos últimos 60 s e uso único por `session_id`+`iat`. Se nem isso for
  comprovável, a alternativa é **WebAuthn** verificado pelo próprio gateway. **Nada disso foi ativado.** Enquanto não
  houver comprovação, as ações sensíveis continuam **bloqueadas** (`MFA_INDISPONIVEL`).

## 9. Segurança (Fase G)

Mantidos e testados: mesmo login; nenhum login financeiro; conta individual; PIN não é identidade forte; conta
compartilhada recusada; impersonação recusada; SuperAdmin e papel `finance` sem acesso implícito; concessões explícitas;
unidade liberada explicitamente; troca de pessoa, sessão e unidade; credencial do gateway separada da aplicação (teste
"13"). As cargas dirigidas novas passam pelo mesmo escopo do repositório (RLS no PostgreSQL); a posição a receber e os
resumos diários da unidade A nunca incluem a unidade A2 (testado).

## 10. Matriz financeira pendente (Fase H)

[24a](24a-matriz-pendencias-decisao.md): os 24 tipos e 7 impedimentos com regra proposta (= implementada), impacto,
evidência, ressalva, condição bloqueante, justificativa e campo de decisão com nome/data em branco. Seis pontos exigem
aprovação humana (lista na 24a). Nenhuma regra alterada. **Não aprovada.**

## 11. Infraestrutura: o projeto Supabase existente (Fase I + adendo)

**Decisão da empresa (adendo à 09C):** o Financeiro v2 usa **o projeto Supabase que a plataforma já usa em
produção**, em **schema dedicado**. Não se cria, recomenda nem provisiona outro projeto ou banco. A comparação de
alternativas feita no início desta execução foi **descartada**. Nada abaixo foi executado em produção.

### Requisitos comprovados no PostgreSQL local (migrações 0001–0021)

`node scripts/fv2/sondaCompatibilidade.mjs` (transação desfeita, nada criado), PostgreSQL 17 local:

| # | Requisito | Origem | Resultado local |
|---|---|---|---|
| R1 | PostgreSQL ≥ 13 | `pg_current_xact_id` (0018) | OK (17) |
| R2 | Papel de migração com CREATEROLE | 0001, 0011 | ATENÇÃO: local é superusuário; no Supabase o `postgres` não é |
| R3 | Criar papéis com e sem login | 0001, 0011 | OK |
| R4 | `FORCE ROW LEVEL SECURITY` + políticas | 0001–0009 | OK |
| R5 | `SECURITY DEFINER` com `search_path` fixo | 0011–0013, 0021 | OK |
| R6 | Transferir posse de função ao guardião **sem ser membro** | 0011 | **FALHA sem superusuário** (`42501: must be able to SET ROLE`) |
| R6b | Mesmo, com participação **temporária** | procedimento A3 | OK |
| R7 | Bloqueio consultivo de transação | 0009, 0011 | OK |
| R8 | `track_counts` e `autovacuum` | 08C/08D | OK |

### Sonda do Supabase existente, simulado (`node scripts/fv2/sondaSupabaseSimulado.mjs`)

Cluster PostgreSQL 17.4 **descartável** (pasta temporária, só 127.0.0.1, apagado no fim) com as características
públicas de um projeto Supabase: `postgres` **não superusuário** com CREATEROLE e BYPASSRLS; `anon`,
`authenticated`, `service_role` (BYPASSRLS) e `authenticator`; schemas `auth`, `storage`, `extensions`; privilégios
**padrão** do `public` concedidos a anon/authenticated/service_role; e uma "plataforma" sintética (tabelas, política,
função e um "financeiro antigo" sintético). As migrações rodam **conectadas como `postgres`**.

| Execução | Aplicação | C0 sistema atual inalterado | C1 RLS | C2 credenciais comuns sem acesso | C3 `service_role` lê dados? | C4 funções protegidas | C5 guardião | C6 limite de confiança |
|---|---|---|---|---|---|---|---|---|
| E1 migrações como estão, `public` | **PARA na 0011**: `42501: must be able to SET ROLE "fv2_guardiao"` | OK | — | — | — | — | — | — |
| **E2 schema `financeiro_v2` + A1–A4** | **0001–0021 aplicadas** | **OK** (sha256 idêntico) | OK (36 tabelas; 5 guardadas sem acesso) | **OK** (0 privilégios, sem USAGE) | **Não** (`permission denied for schema`) | OK (8 funções, dono guardião, search_path no schema) | ATENÇÃO | ATENÇÃO |
| E3 `public` + A1–A4 | aplicadas | OK | **FALHA** (guardadas acessíveis) | **FALHA** (201 privilégios herdados dos padrões) | **SIM** (BYPASSRLS) | **FALHA** (EXECUTE para anon/authenticated/service_role) | ATENÇÃO | ATENÇÃO |

**Conclusões:**
1. **Incompatibilidade exata** das migrações como estão: a 0011 (e 0012, 0013, 0021) transfere/recria funções do
   `fv2_guardiao`; sem superusuário isso exige poder usar o papel (`SET ROLE`).
2. **No `public` do projeto existente o v2 ficaria exposto:** os privilégios padrão do Supabase dão às credenciais
   comuns acesso às tabelas e funções novas, e o `service_role` (credencial comum do backend da plataforma) **ignora
   RLS**. Por isso o schema **dedicado** é obrigatório, não opcional.
3. **Com o schema dedicado e as adaptações A1–A4**, tudo aplica como `postgres`, sem tocar em objeto, ACL, política,
   privilégio padrão ou papel do sistema atual (C0), e nenhuma credencial comum alcança dado financeiro.

### Adaptações seguras (não enfraquecem autorização, isolamento, auditoria ou integridade)

| # | Adaptação | Por quê |
|---|---|---|
| A1 | `create schema financeiro_v2`, `revoke all … from public`; papéis `fv2_app`/`fv2_autoridade`/`fv2_guardiao` criados antes (as migrações já usam "se não existir") | fora do alcance dos padrões do `public` e da API de dados |
| A2 | `search_path` das funções protegidas = `pg_catalog, financeiro_v2, pg_temp` (troca textual verificada: 9 ocorrências em 0011/0012/0013/0021) | as funções passam a resolver só o schema dedicado |
| A3 | Na mesma transação de cada migração que transfere ou recria função do guardião: `grant fv2_guardiao to current_user` + `CREATE` temporário no schema → migração → `revoke` dos dois | substitui o superusuário sem deixar participação utilizável |
| A4 | `USAGE` no schema só para `fv2_app`, `fv2_autoridade`, `fv2_guardiao` | credenciais comuns sem caminho até o schema |

Como os arquivos 0001–0021 **não** mudam (hashes preservados), a proposta é um **aplicador com schema como
parâmetro** que faz A1–A4 de forma determinística e registra, por migração, o hash original e o hash do texto
aplicado. Implementado nesta execução **só na sonda**; o banco de testes da suíte continua no `public` do cluster
isolado (PRÓXIMO PASSO: rodar a suíte PostgreSQL inteira contra o schema dedicado, com o `search_path` vindo do papel
de login).

### O que exige decisão (ATENÇÃO, não bloqueio técnico)

- **C5 — participação ADMIN implícita (PostgreSQL 16+):** quem cria um papel sem ser superusuário fica com ADMIN sobre
  ele (sem SET e sem INHERIT). Não dá acesso aos privilégios do guardião, mas permite ao `postgres` conceder-se SET
  depois. Retirar exige superusuário (suporte do Supabase). Em PostgreSQL 15 a semântica de CREATEROLE é outra: a
  versão real do projeto é item de verificação.
- **C6 — limite de confiança:** o papel `postgres` (e o `supabase_admin`/editor SQL do painel) tem BYPASSRLS. Quem
  tiver essas credenciais lê os dados financeiros — exatamente como já lê os dados da plataforma hoje. Mitigações:
  nenhuma parte do v2 usa `postgres` ou `service_role`; credenciais de administração com poucas pessoas e registro de
  uso; dados financeiros nunca expostos pela API de dados. **A empresa precisa aceitar esse limite (D-24-1).**

### Credenciais separadas

- Backend comum da plataforma: segue com `service_role`/`postgres` — **sem USAGE** no `financeiro_v2` (C2/C3).
- v2: papéis de **login próprios** (`fv2_app_login` ∈ `fv2_app`; `fv2_gateway_login` ∈ `fv2_autoridade`), senhas
  distintas, `search_path` definido no papel. A autoridade financeira continua separada da credencial comum (teste "13").

### Conexões e pooler

A sessão de banco do v2 (0011) zera o valor de sessão `fv2.sessao` e grava o token **local à transação**
(`set_config(..., true)`); os bloqueios consultivos são de transação; o driver `pg` usa comandos sem nome: compatível
com pool em modo transação (um valor de sessão vazio que sobra na conexão do pool significa "sem sessão", o lado
seguro) — a confirmar no Supavisor real. **Gateway** e migrações por conexão direta ou pooler em modo sessão.
Limite de conexões: o v2 precisa de um pool pequeno e fixo (sugestão inicial: aplicação 5, gateway 2), somado ao uso
atual — **a medir** antes da ativação.

### Capacidade (sem acesso a produção) — consultas SÓ-LEITURA preparadas para quando houver autorização

```sql
select version();
select rolname, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname in ('postgres','service_role','anon','authenticated','authenticator');
show createrole_self_grant;
select nspname from pg_namespace where nspname = 'financeiro_v2';            -- conflito de nome (esperado: nada)
select rolname from pg_roles where rolname like 'fv2\_%';                     -- conflito de papel (esperado: nada)
select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl from pg_default_acl;
show max_connections; select count(*) from pg_stat_activity;
select pg_size_pretty(pg_database_size(current_database()));
select current_setting('track_counts'), current_setting('autovacuum');
```

Impacto estimado das consultas do v2 (medido no PostgreSQL isolado, § 6–7): dezenas de consultas e poucas mil linhas
por tela com 48 meses; nenhuma varredura das tabelas da plataforma.

### Cofre documental no Storage existente

Bucket **privado** `financeiro-v2-cofre`, sem políticas para `anon`/`authenticated`. Como o `service_role` também
alcança o Storage, a proteção não pode depender só do bucket: (1) **cifra no aplicativo** (chave do cofre com o
gateway, nunca com o backend comum) — quem lê o objeto sem a chave vê só bytes cifrados; (2) **sha256** de cada
objeto guardado nas tabelas do v2 (protegidas): objeto trocado é detectado; (3) validação de tipo e tamanho (10 MiB)
como no cofre local; (4) **antimalware** em quarentena antes de liberar (serviço à parte, a escolher). Se a cifra no
aplicativo não for aceita, o cofre fica **bloqueado** (não se enfraquece).

### Inventário, conflitos, backup, rollback e desativação do v2

- **Inventário a criar:** schema `financeiro_v2`; 36 tabelas `fv2_*` + registro de migrações; funções e políticas das
  migrações; papéis `fv2_app`, `fv2_autoridade`, `fv2_guardiao` e os de login. **Nada** no `public`, `auth`,
  `storage` ou em objetos existentes (provado pelo C0).
- **Conflitos:** as duas consultas de nome acima; o v2 não usa extensões.
- **Backup:** `pg_dump -n financeiro_v2` antes de cada migração. O backup/PITR do projeto restaura **tudo**: não é
  desfazer seletivo do v2.
- **Rollback de migração:** transação única por migração (falhou = nada aplicado) + aplicador recusa migração editada.
- **Desativação do v2:** liberação desligada (volta ao estado anterior por unidade) → `alter role … nologin` nos
  papéis de login → dados preservados. Remover o schema só com decisão explícita e backup verificado.

## 12. Acessibilidade (Fase J)

Verificações automatizadas reexecutadas (contraste AA nos dois temas, auditor de rótulos/papéis, teclado e 390 px no
navegador real da 09B): suíte do frontend **1951 aprovados, 0 falhas, 26 pulados**, incluindo "contraste — tema
claro/escuro: componentes críticos atendem WCAG AA" e "navegação e acessibilidade". Nenhuma tela nova de interface
nesta execução (a posição a receber ainda não tem tela). **Leitor de tela real: NÃO TESTADO** (NVDA não instalado; Narrador sem
captura verificável). Requisito **pendente** até existir evidência.

**Roteiro objetivo para uma pessoa com leitor de tela (NVDA ou Narrador), registrar "ok / incompleto / ausente":**

| Área | Passos |
|---|---|
| Entrada e navegação | Pular para o conteúdo; menu lateral anuncia "navegação Financeiro v2" e a página atual (`aria-current`); filtros de competência e unidade têm rótulo |
| Visão Geral | Cartões anunciam nome, valor e situação ("aguardando conferência"); botão "Como este valor é calculado" abre o painel e o foco vai para "Fechar" |
| DRE | Linhas lidas com nome e valor; composição do indicador abre em painel; "Ver vendas" anuncia o canal |
| Tabelas | Navegação por células (setas de tabela) anuncia o cabeçalho da coluna; no celular, cada célula traz o rótulo |
| Calendário | Dias com contas anunciam data e quantidade; seleção de dia por teclado |
| Upload | Campo de arquivo com rótulo; limite de 10 MiB anunciado; resultado em `role="status"` |
| Reclassificação | Escolha da categoria, "Ver prévia do impacto", confirmação com documento e justificativa; erros anunciados |
| Conciliação | Lados da correspondência, diferença e evidências lidos em ordem; confirmar/rejeitar anunciam o resultado |
| Baixa bancária | Lista de saídas; prévia "nada foi gravado"; alerta de pagamento antecipado (`role="alert"`) sem roubar o foco; caixa obrigatória anunciada |
| Fechamento | "O que impede homologar" lido em ordem; botões indisponíveis anunciam o motivo (`aria-describedby`) |
| Mensagens de erro | Recusas do servidor (409/403) anunciadas no `role="status"` do formulário |

## 13. Testes e regressões

| Conjunto | Resultado |
|---|---|
| Backend financeiro-v2, memória (`FV2_PG_DIR` inexistente) | **388 testes: 327 aprovados, 0 falhas, 61 pulados** (PostgreSQL) |
| Base `2b07fe1`, mesmas condições (worktree temporário) | 380: 319 aprovados, 0 falhas, 61 pulados |
| Comparação de nomes base × agora | **nenhum teste da base sumiu**; 8 novos (09C) |
| Modo de conferência `FV2_CONFERIR_CARGA=1` com PostgreSQL | **388/388** |
| Suíte inteira com o repositório PostgreSQL (`FV2_REPOSITORIO=postgres`, `--test-concurrency=1`) | **388/388** |
| Frontend | 1951 aprovados, 0 falhas, 26 pulados |
| Mutação 09C (`mutacao09c.py`, 12 mutantes nas cargas dirigidas e na posição) | 1ª rodada 8/12; os 4 sobreviventes expuseram **lacunas do cenário** (nenhum movimento no 1º dia do mês, nunca 2 movimentos no mesmo dia, nenhuma conta a pagar paga fora do período). Gerador enriquecido → M52, M53, M54 **detectados**. **M62 é equivalente**: os pagamentos dos títulos não mudam o resumo (só o detalhe de item, que o resumo descarta) → a leitura foi **retirada** da carga do resumo e a conferência completa voltou a passar. Resultado: **11/11 não equivalentes detectados** |
| Sonda de compatibilidade local (R1–R8) | ver § 11 |
| Sonda do Supabase simulado (E1–E3, C0–C6) | ver § 11 |

Mudança de código depois da primeira medição: só a retirada da leitura de pagamentos na carga do resumo (M62).

## 14. Bloqueios externos

1. **Autenticação real** para os 4 itens da § 8 (com autorização, num ambiente que não seja produção).
2. **Consultas só-leitura** da § 11 no projeto existente (versão, atributos de papéis, privilégios padrão, conflitos
   de nome, conexões, tamanho) — exigem autorização específica.
3. **Limite de confiança C6** e participação ADMIN (C5) aceitos pela empresa (D-24-1).
4. **Cifra do cofre no aplicativo** e serviço antimalware (§ 11) definidos.
5. **Aprovação da matriz** (24a).
6. **Leitor de tela** por uma pessoa (§ 12).
7. **Volume real anonimizado** para confirmar as hipóteses de desempenho.
8. Substituição do legado: decisões D-24b-1 a D-24b-5 ([24b](24b-substituicao-financeiro-antigo.md)).

## 15. Critérios de entrada na homologação no projeto existente

Entrar quando TODOS valerem: (a) autorização específica, em palavras próprias, para cada operação no projeto
existente; (b) consultas só-leitura da § 11 executadas, sem conflito de nome e com versão/papéis compatíveis com a
sonda; (c) aplicador com schema dedicado (A1–A4) implementado e a suíte PostgreSQL inteira verde contra o schema
dedicado no cluster isolado; (d) foto C0 do sistema atual tirada antes e conferida depois da aplicação; (e) papéis de
login próprios e gateway com credencial própria; (f) cofre cifrado e antimalware definidos; (g) D-24-1 decidido.
Ações sensíveis continuam bloqueadas até a § 8 ser comprovada; o financeiro antigo só sai conforme o doc 24b.

## Commits locais

- `6980ba7` — código, testes, sondas e matriz 24a (parte 1).
- commit seguinte — este documento e o 24b (parte 2).

Sem push, merge ou deploy. `docs/financeiro-v2/02-referencia-setembro.md` (privado) fora do Git.
