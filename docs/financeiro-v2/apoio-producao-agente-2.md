# Financeiro v2 — Apoio à implantação (Agente 2)

Entrega para o **Agente 1** (responsável pela implantação). Tudo aqui foi feito em ambiente **local e descartável**:
nenhum serviço real foi acessado, nenhum `.env` foi lido, nada foi publicado, migrado em produção ou enviado (sem push,
merge ou deploy). Este documento não contém segredo.

## 1. Origem e estado

| Item | Valor |
|---|---|
| Commit de origem | `0a99637` (Execução 09C, parte 2) — checkpoint confirmado no repositório |
| Branch do Agente 2 | `feat/financeiro-v2-apoio-producao`, worktree próprio em `C:\dev\fv2-agente2` (fora do OneDrive) |
| Trabalho do Agente 1 observado | checkout principal na branch `feat/financeiro-v2-producao` (HEAD `0a99637`), com alterações **não commitadas** em `fv2-banco-teste.mjs`, `fv2-homologacao.mjs`, `ambiente.mjs`, `sondaSupabaseSimulado.mjs`, `helpers/postgres.js` e `postgres-integridade.test.js` (aplicador do schema dedicado na suíte). **Nenhum** desses arquivos foi alterado pelo Agente 2 |
| Banco isolado do Agente 2 | cluster próprio `%LOCALAPPDATA%\fv2-pg-teste-agente2`, porta 54349 (não compartilha pasta nem porta) |
| Commits locais | `3002562` (auditoria do schema dedicado) + o commit deste documento |

### Incidente registrado (sem dano)

Uma rodada de testes de **mutação** rodou por engano contra a pasta **do Agente 1**: o caminho base do roteiro não foi
trocado. O roteiro altera um arquivo por vez, roda os testes e o restaura por cópia, com conferência de hash.

Verificação feita logo depois:
- Os quatro arquivos tocados (`competencias.js`, `ressalvas.js`, `baixaPorExtrato.js` e
  `0018_fechamento_ressalvas_baixa_extrato.sql`) estão **idênticos ao HEAD** e não tinham alteração pendente do
  Agente 1. Não sobrou nenhum arquivo `.bak`.
- As seis alterações não commitadas do Agente 1 continuam lá, inalteradas.
- O banco usado foi o do Agente 2 (variáveis de ambiente próprias).

O roteiro agora recusa qualquer caminho fora do worktree do Agente 2, e a mutação foi refeita no worktree certo (§ 4).

## 2. Linha de base em `0a99637` (cluster do Agente 2)

| Suíte | Resultado |
|---|---|
| Financeiro v2 em memória | **388/388** |
| Financeiro v2 em PostgreSQL | **388/388** |
| Frontend (`frontend/test/*.test.js`) | **1951 passando, 0 falhas**, 26 pulados (1977) |

## 3. Prioridade A — compatibilidade com o Supabase existente

### 3.1 Reprodução da sonda da 09C (`sondaSupabaseSimulado.mjs`)

Resultado **idêntico** ao do doc 24 § 11 (PostgreSQL 17.4 descartável, `postgres` sem superusuário):

| Execução | Resultado |
|---|---|
| E1 (migrações como estão, `public`) | Para na 0011: `42501 must be able to SET ROLE "fv2_guardiao"` |
| E2 (`financeiro_v2` + A1–A4) | 0001–0021 aplicadas; C0–C4 OK; C5 e C6 em ATENÇÃO |
| E3 (`public` + A1–A4) | Exposto: C1–C4 FALHA |

As quatro adaptações conferidas são as do doc 24 (A1 schema dedicado, A2 `search_path`, A3 participação temporária no
guardião, A4 USAGE só dos papéis do módulo). Nenhuma adaptação foi inventada além da A5 abaixo, que é **proposta**.

### 3.2 Auditoria independente (`backend/scripts/fv2/auditoriaSupabaseAgente2.mjs`)

Cobre o que a sonda não cobre. São três clusters descartáveis, todos com as migrações aplicadas como `postgres` no
`financeiro_v2` com A1–A4 e com logins próprios (`fv2_app_login`, `fv2_gateway_login`, `search_path` no papel).

| Verificação | S1 padrões só no `public` | S2 HOSTIL: padrões **globais** do `postgres` + publicação `FOR ALL TABLES` | S3 = S2 + **A5** |
|---|---|---|---|
| K1a papéis do módulo sem DELETE/TRUNCATE (TRUNCATE passaria por cima de RLS e gatilhos) | OK | OK | OK |
| K1b credenciais comuns sem privilégio nas tabelas | OK | ATENÇÃO (864 herdados) | OK |
| K1c gateway sem acesso direto a tabela financeira | OK | OK | OK |
| K2a `SECURITY DEFINER` dos papéis do módulo só na lista das migrações | OK | OK | OK |
| K2b EXECUTE herdado (via PUBLIC) em funções comuns, sem USAGE | ATENÇÃO (153) | ATENÇÃO (180) | ATENÇÃO (153) |
| **K2c `SECURITY DEFINER` executável por anon/authenticated/service_role** | OK | **FALHA (24, inclusive `fv2_abrir_sessao`)** | OK |
| K3 objeto criado depois no schema (canário) | OK | ATENÇÃO | OK |
| **K4 tabelas `fv2_*` em publicação de replicação** | OK | **FALHA (36 tabelas)** | **FALHA** |
| K5 login da aplicação sem sessão: 13 ataques SQL diretos | OK | OK | OK |
| K6 login do gateway não lê nem escreve dado financeiro | OK | OK | OK |

Os 13 ataques do K5 são:
- leitura e escrita sem sessão;
- token forjado e `set_config` manipulado (nenhum dos dois gera sessão, permissão ou leitura; a escrita é recusada);
- TRUNCATE e DELETE;
- leitura das tabelas guardadas;
- chamada a funções do gateway;
- autoconcessão;
- `SET ROLE` para o guardião;
- desligar RLS;
- DDL no schema.

**Achados para o Agente 1** (dependem da configuração REAL do projeto; não confirmados em produção):

1. **A-1 Privilégios padrão globais.**
   - Se o papel `postgres` do projeto tiver privilégios padrão **sem** `IN SCHEMA` (S2), cada objeto criado no
     `financeiro_v2` já nasce concedido a anon/authenticated/service_role. Isso inclui 24 concessões em funções
     `SECURITY DEFINER`, entre elas a **emissão de sessão** (`fv2_abrir_sessao`).
   - Hoje só a falta de USAGE no schema segura; a segunda barreira some.
   - Esse padrão global **não** se revoga com `alter default privileges … in schema …`: o PostgreSQL não retira por
     schema o que foi dado globalmente.
   - **Correção proposta, A5:** na MESMA transação de cada migração, com a mesma participação temporária no guardião
     da A3, rodar `revoke all on all tables|sequences|functions in schema financeiro_v2 from anon, authenticated,
     service_role`. Provada no S3; o código de referência está no script (`a5`).
2. **A-2 Publicação `FOR ALL TABLES`.**
   - Se a publicação `supabase_realtime` (ou outra) do projeto for `FOR ALL TABLES`, as **36 tabelas** do v2 entram
     nela automaticamente: o dado financeiro passa a ir para o fluxo de replicação lógica.
   - O aplicador **não** consegue excluir: a publicação é da plataforma.
   - É um **bloqueio condicional**. Verificar antes de aplicar (consulta abaixo). Se for `FOR ALL TABLES`, decidir
     com o proprietário: converter a publicação para lista explícita (mudança na plataforma) ou adiar.
3. **Consultas SÓ-LEITURA que faltam no doc 24 § 11** (somar às já preparadas lá):

```sql
select pubname, puballtables from pg_publication;                                  -- A-2: FOR ALL TABLES?
select defaclrole::regrole, defaclnamespace, defaclobjtype, defaclacl
  from pg_default_acl where defaclnamespace = 0;                                   -- A-1: padrões GLOBAIS (sem schema)
select evtname, evtevent, evtfoid::regproc from pg_event_trigger;                  -- gatilhos de DDL do projeto (pg_graphql/PostgREST)
```

## 4. Prioridade B — segurança

**Mutação refeita no worktree do Agente 2: 15/15 mutantes detectados.** Os mutantes cobrem:
- bypass da homologação, no núcleo e no banco;
- ressalva direto do preliminar;
- texto sem decisão;
- saída sem vínculo virando ressalva;
- dupla baixa: sem idempotência e com saldo não conferido;
- dupla alocação: acima do disponível, saída esgotada, sem trava ou versão;
- falta de permissão, no núcleo e no banco;
- alteração em competência homologada (documentar e reescrever pendências);
- baixa sem evidência.

Os 20 ataques pedidos já têm prova automatizada que passa na linha de base (388/388 em memória **e** em PostgreSQL),
mais a auditoria do § 3.2:

| # | Ataque | Prova (arquivo :: teste) |
|---|---|---|
| 1 | Sem sessão | `sessao-cofre-local` :: sessão ausente, inválida, expirada…; auditoria K5 |
| 2 | Outra organização | `postgres-seguranca` :: 13, 14, 15 — outra organização, outra unidade e documento fora do escopo |
| 3 | Outra unidade | `acessos-sessao` :: isolamento: concessão numa unidade não vale em outra…; `postgres-barreiras-08c` :: ação concedida em OUTRA unidade |
| 4 | Token falsificado | `identidade-mfa-liberacao` :: MFA falsificado…; `postgres-seguranca` :: 5, 6, 12 — identidade forjada…; K5 |
| 5 | Sessão expirada | `homologacao-gateway` :: sessão do gateway EXPIRADA…; `sessao-cofre-local` |
| 6 | Permissão revogada | `postgres-permissao-por-acao` :: revogação de UMA ação no meio da transação; `postgres-seguranca` :: 9 |
| 7 | Autoconcessão | `acessos-sessao` :: escalada de privilégio é recusada…; `postgres-seguranca` :: 3, 4; K5 |
| 8 | Escalada | `acessos-sessao` :: escalada…; `postgres-permissoes-granulares` :: 08B — revogar ≠ conceder… |
| 9 | Leitura SQL direta | `postgres-integridade` :: isolamento no banco (RLS)…; K5, K6 |
| 10 | Escrita SQL direta | `postgres-permissao-por-acao` :: cada ação só grava o que lhe cabe NO BANCO; `postgres-seguranca` :: 1, 2 |
| 11 | Contornar RLS | `postgres-integridade` :: isolamento no banco (RLS); K5 (desligar RLS, TRUNCATE) |
| 12 | Função privilegiada indevida | `postgres-seguranca` :: 1, 2 e 5, 6, 12; K2a, K2c, K5 |
| 13 | Concorrência de autorização | `acessos-sessao` :: concessões concorrentes…; `postgres-seguranca` :: 9 — concorrência não escala privilégio |
| 14 | Homologação não autorizada | `isolamento-autorizacao` :: homologar e revisar são permissões separadas de fechar; `fechamento-ressalvas-baixa` :: banco — homologar à mão… (FV040) |
| 15 | Reabertura sem permissão | `postgres-barreiras-08c` :: reabrir competência homologada exige `reabrir` |
| 16 | Alteração em homologada | `postgres-integridade` :: competência homologada é protegida também no banco; `postgres-fechamento` :: persistência protege… |
| 17 | Documento de outra unidade | `postgres-seguranca` :: 13, 14, 15; `importacoes-fluxo` :: cofre: documento preservado… exige permissão e escopo |
| 18 | Aplicação repetida | `auditoria-cadeias` :: cadeia de importação: aplicação única (repetida e concorrente) |
| 19 | Conciliação duplicada | `documentos-conciliacao` :: o mesmo valor não é conciliado duas vezes |
| 20 | Manipulação de contexto | `acessos-sessao` :: 07B — contexto que alega `conceder`…; `postgres-seguranca` :: 5, 6, 12; K5 (`set_config`) |

Nenhuma proteção foi enfraquecida para estes testes.

## 5. Prioridade C — auditoria financeira (sintética)

Todos os cenários pedidos têm teste, e todos estão nos 388 da linha de base (memória e PostgreSQL):

| Cenário | Prova |
|---|---|
| Venda de setembro recebida em outubro | `configuracoes-fechamento` :: 3 — legítimo em outubro, sem reescrever a versão homologada |
| Obrigação de setembro paga em outubro | `fechamento-ressalvas-baixa` :: 20, 21 — baixa em outubro, versão de setembro intacta |
| Pagamento parcial, agrupado, várias saídas, saída já utilizada | `fechamento-ressalvas-baixa` :: 13–17 |
| Estorno posterior | `auditoria-competencias` :: A1 |
| Movimento sem classificação | `auditoria-competencias` :: A8; F-1: saída sem vínculo bloqueia a homologação |
| Taxa descoberta depois | `auditoria-competencias` :: A3 |
| Segunda homologação e reabertura | `auditoria-competencias` :: A7; `configuracoes-fechamento` :: 5, 6, 9, 32–36 |
| DRE contra conta feita à mão | `auditoria-cenario-integrado` :: B |
| Canais × DRE | `apuracao` :: Fase F |
| Baixa antecipada | `fechamento-ressalvas-baixa` :: Execução 09 — saída anterior à emissão |

Como a integração reaproveita o mesmo núcleo, os resultados financeiros não dependem dela. O risco está na **troca de
schema**, e a A5 e o K5 cobrem a camada de banco. Fica pendente, com o Agente 1: rodar estes mesmos 388 testes no
schema dedicado, que é o trabalho não commitado dele.

## 6. Prioridade D — substituição do legado (doc 24b)

Inventário **conferido** nas migrações 120–122 e 151–156: **29 tabelas** e **74 funções**, exatamente como o 24b.

- O motor `financeiro-calculos/motor.js` só é importado pelo módulo antigo.
- `/plataforma/financeiro` (cobrança) não toca em `fin_*`.
- O Dashboard Executivo não depende do legado. O grafo os liga por agrupamento, mas não há importação.

**Achado L-1 (não está no 24b):** o **endpoint de sessão da plataforma** depende do legado.
- `modules/sessao/sessao.controller.js` → `calcularSetores` (`shared/setores.js`) usa
  `resolverAcessoFinanceiro` (`middlewares/financeiro.js`). Esse resolvedor lê a tabela legada
  `gestao_financeira_concessoes` (`somente_financeiro`, `nivel`), e o `MODULO_FINANCEIRO` vem de
  `gestaoFinanceira.permissoes.js`.
- Esse cálculo decide, para **todos os usuários**, se aparecem os setores "financeiro" e "operacional".
- **Risco:** remover o roteador, o middleware ou a tabela (F5/F6) sem antes migrar essa regra faz o usuário hoje
  "somente financeiro" deixar de ser reconhecido. Ele passaria a receber o setor **operacional**: uma ampliação de
  acesso silenciosa.
- **Tratamento:** incluir `sessao.controller.js`, `setores.js` e `resolverAcessoFinanceiro` na tabela de pontos de
  contato do 24b § 3. Exigir, antes de F5, uma fonte nova para "financeiro"/"somente financeiro", por exemplo as
  concessões do v2, decisão D-24b-1. Também ter um teste de regressão desse cálculo com a tabela antiga ausente.

Os demais pontos do 24b § 3 conferem:
- módulo `gestao_financeira` e item de menu (porta de entrada do v2);
- `GET /gestao-financeira/status` (o encaixe do v2 lê o bloco `financeiroV2` daqui: mover antes de remover o roteador);
- guarda `trg_unidades_guarda_financeiro`;
- `/plataforma/gestao-financeira/concessoes`;
- `modulos_categoria_check`.

**Menu e rotas:** o encaixe (`frontend/src/financeiroV2Encaixe.js`) substitui o menu sem duplicar e "desligar volta ao
atual" (`financeiroV2Encaixe.test.js`: 14, 24 e 15). O encaixe ainda **não** está ligado à aplicação (teste "não
ativado"). Ligá-lo é tarefa do Agente 1; a matriz do § 8 tem as verificações.

**Reversão:** por unidade, pela liberação 0021 (desligar volta ao legado). Está coberta por
`identidade-mfa-liberacao` e pelo encaixe.

## 7. Prioridade E — desempenho

Gerador `scripts/fv2-desempenho.mjs` no cluster do Agente 2. Dados sintéticos com duas unidades: a grande, mais uma
pequena para medir o isolamento. Tempos em milissegundos, mediana de 5 execuções, PostgreSQL 17 local com `fsync`
desligado. Servem para comparar, não como meta de produção. "Antes" é a carga completa; "depois" é a carga dirigida
atual.

| Tela | 12 meses antes → depois | 48 meses (4× o volume) antes → depois |
|---|---|---|
| Visão Geral | 422 → 193 | 1377 → 623 |
| Caixa e bancos (resumo diário no banco, 09C) | 317 → **30** | 1148 → **38** |
| Fluxo de caixa | 344 → 245 | 1187 → 728 |
| Contas a receber (página) | 338 → 217 | 1203 → 840 |
| Contas a receber (competência, 09C) | 347 → **27** | 1181 → **21** |
| Posição a receber (fim do mês) | 328 → 200 | 1185 → 614 |
| Contas a pagar | 320 → 49 | 1143 → 146 |
| Detalhes (venda, recebível, conta) | 408–575 → 62–237 | 1157–1964 → 141–247 |
| Vendas, Recebimentos, Central, Pendências, Fechamento, Prévia | 525–625 → 192–238 | 1857–2143 → 243–274 |
| Unidade pequena (Central, Vendas) | 21–27 → 32–41 | 18–25 → 29–35 |
| DRE do mês | 52 | 55 |
| 10 telas simultâneas | 858 | 2410 |

- **Equivalência:** 12/12 e 48/48 meses idênticos; 18/18 telas idênticas à carga completa.
- **Memória do processo do gerador:** 178 MB (12 meses) e 598 MB (48 meses).
- **Isolamento:** a unidade pequena fica em 29–41 ms com 12 ou 48 meses da grande.
- **Ainda crescem com o histórico:** Fluxo de caixa, Contas a receber paginada, Visão Geral e Posição a receber.
  Esse é o crescimento residual já registrado na 09C. Nenhuma refatoração foi feita (não houve evidência nova de
  necessidade).

**Achado P-1 (corrigido no branch do Agente 2):** o gerador ficou desatualizado depois da 08E/0019.
- Ele fechava todo mês "com pendências" usando nota livre, e o núcleo, corretamente, recusa isso agora: 8 "falhas de
  carga" em 2026-01..08.
- Por isso as medições acima rodaram com esses meses **sem** versão de fechamento.
- A correção documenta as pendências admissíveis pelo caminho normal. Se sobrar pendência bloqueante, o mês fica no
  preliminar e isso é registrado como **esperado**, com a causa (`SAIDA_SEM_CLASSIFICACAO`, `PROPOSTA_EM_ABERTO`).
- Prova numa carga de 3 meses: 0 falhas, 2 meses explicados.
- A regra não foi afrouxada.

## 8. Prioridade F — matriz de aceite para produção (roteiro NÃO executado)

Nada abaixo foi executado em produção. A coluna "Como" descreve verificações **não destrutivas** (leitura, ou ação com
usuário de teste numa unidade piloto, conforme a autorização que o Agente 1 tiver).

| # | Verificação | Como | Esperado | Evidência local |
|---|---|---|---|---|
| P1 | Login existente | entrar pela tela atual | sessão da plataforma criada; nada novo no login | `integracao-plataforma` |
| P2 | Sessão validada | chamar uma rota do v2 sem sessão e com sessão | 401 sem; 200 com | `sessao-cofre-local` |
| P3 | Empresa/unidade corretas | trocar de unidade no seletor | o v2 mostra só a unidade escolhida; resposta antiga descartada | `financeiroV2Encaixe` 6 |
| P4 | Menu sem duplicação | abrir "Dashboard Financeiro" na unidade piloto | sete áreas do v2, nenhum item antigo | `financeiroV2Encaixe` 14, 24 |
| P5 | v2 só na unidade autorizada | consulta de leitura em `fv2_liberacao` + abrir outra unidade | só a piloto ativa | `identidade-mfa-liberacao` |
| P6 | Unidade não habilitada inalterada | abrir o Dashboard Financeiro em outra unidade | exatamente o de hoje | `financeiroV2Encaixe` 15 |
| P7 | Sem permissão → negado | usuário sem concessão do v2 na piloto | tela de acesso negado, nunca o legado | encaixe "sem concessão = negado" |
| P8 | Gateway com credencial isolada | consulta de leitura `pg_roles` + `has_schema_privilege` | só `fv2_gateway_login` ∈ `fv2_autoridade`; backend comum sem USAGE | sonda C2/C3; auditoria K6 |
| P9 | MFA em operação sensível | homologar sem segundo fator recente | recusado | `identidade-mfa-liberacao` |
| P10 | RLS | consultas do § 3.2 em modo leitura (privilégios, publicação, padrões globais) | K1–K4 OK | auditoria K1–K4 |
| P11 | Documentos | enviar PDF sintético na piloto; abrir de outra unidade | aceito; outra unidade negada | `postgres-seguranca` 13–15 |
| P12 | DRE | conferir uma competência sintética de teste ou a abertura | soma das folhas = total | `auditoria-cenario-integrado` B |
| P13 | Caixa | saldo informado = calculado | diferença 0 | suíte 06A/08D |
| P14 | Fechamento | homologar só com pendências tratadas | recusa com motivos quando há pendência | `fechamento-ressalvas-baixa` 2–4 |
| P15 | Reversão | desligar a liberação da piloto | volta ao legado sem perda | encaixe "desligar volta ao atual"; 24b F1 |
| P16 | Outros módulos preservados | regressão do backend (§ 9) + abrir iFood, Foody, Parser e Dashboard Executivo | inalterados | § 9 |
| P17 | Sessão e setores (L-1) | usuário "somente financeiro" | continua sem o setor operacional | **teste a criar antes de F5** |

## 9. Testes executados pelo Agente 2

| Bloco | Resultado | Comparação |
|---|---|---|
| Financeiro v2 em memória | 388/388 | linha de base `0a99637` |
| Financeiro v2 em PostgreSQL (cluster próprio) | 388/388 | linha de base `0a99637` |
| Frontend | 1951 passando, 0 falhas, 26 pulados | linha de base `0a99637` |
| Sonda do Supabase simulado (09C) | E1/E2/E3 idênticos ao doc 24 | doc 24 § 11 |
| Auditoria independente S1/S2/S3 | § 3.2: K5 e K6 OK nos três; achados A-1 (corrigido pela A5 no S3) e A-2 (condicional) | — |
| Mutação | 15/15 detectados (no worktree do Agente 2) | 08E: 15/15 |
| Regressão do backend (`test/*.test.js`, env fictício, sem `.env`) | 6469 testes, 6427 passando, 16 falhas, 1 cancelado | lista de falhas **idêntica** à da 08D (`03ee7a5`): nenhuma nova; todas de outros módulos e pré-existentes |
| Desempenho | 12 e 48 meses, equivalência total | § 7 |

Os arquivos alterados pelo Agente 2 são todos novos ou isolados:
- `backend/scripts/fv2/auditoriaSupabaseAgente2.mjs` (novo);
- `backend/scripts/fv2-desempenho.mjs` (gerador: só o trecho de fechamento sintético);
- este documento.

Nenhum arquivo de produto (núcleo, migrações, frontend) foi alterado. Os arquivos em edição pelo Agente 1 não foram
tocados.

## 10. Instruções de integração para o Agente 1

1. **Antes de aplicar no projeto real:** rodar as consultas só-leitura do doc 24 § 11 **e** as três do § 3.2 acima.
   - Se houver padrões globais do `postgres`, incorporar a **A5** no aplicador. O código de referência está em
     `auditoriaSupabaseAgente2.mjs`, na transação de cada migração: com a participação temporária do guardião,
     `revoke all on all tables|sequences|functions in schema financeiro_v2 from anon, authenticated, service_role`.
   - Se a publicação for `FOR ALL TABLES`: **parar e decidir** com o proprietário (A-2).
2. **Para incorporar:** `git cherry-pick 3002562` e o commit deste documento, ou merge da branch
   `feat/financeiro-v2-apoio-producao`. São só arquivos novos, sem conflito com o trabalho não commitado do Agente 1.
3. **Depois que o aplicador do schema dedicado estiver na suíte** (trabalho do Agente 1): rodar
   `node scripts/fv2/auditoriaSupabaseAgente2.mjs` e a suíte de 388 testes no schema dedicado. Comparar com este
   relatório.
4. **Antes da F5 do 24b:** tratar o L-1 (sessão e setores) e criar o teste P17.

## 11. Confirmação

- Nenhum serviço real alterado.
- Supabase de produção não acessado; `backend/.env` não lido; nenhuma migração real executada.
- Nenhuma unidade ativada; nenhuma credencial ou permissão real alterada; sem push, merge ou deploy.
- Clusters usados: o próprio do Agente 2 (porta 54349) e clusters descartáveis em pasta temporária (portas 54359 e
  54369), parados e apagados.
- Processos e pastas do Agente 1 não foram encerrados nem apagados. O incidente do § 1 foi verificado: sem dano.
