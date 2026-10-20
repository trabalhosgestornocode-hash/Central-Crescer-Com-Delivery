# 20 — Compatibilidade organizacional: transferência/promoção de unidades × Financeiro

Data: 2026-10-19 · Correção **local** (sem push, PR, merge, deploy, migration remota ou alteração no Supabase de testes). Provas só em PostgreSQL **local descartável**. Revisão independente **ausente** (risco residual).

## 1. Causa exata
| Item | Como é hoje (053/054, sem alteração na `main`) |
|---|---|
| Quem chama | `transferir_unidade_organizacao` e `promover_unidade_para_empresa` (RPCs do SuperAdmin; backend `plataforma.estrutura.service.js`, `traduzirErroRpc`: P0002→404, 22023→400 com a mensagem, resto→500). Nenhum outro código do repositório chama `remapear…` |
| Descoberta de tabelas | `remapear_organizacao_em_tabelas_de_unidade` lê `information_schema` e pega **toda** tabela-base do `public` com `organizacao_id` **e** `unidade_id`, exceto `martin_brower_vinculos`, `sessoes_contexto` e `insumo_historico` |
| UPDATEs | um `update public.<t> set organizacao_id = nova where unidade_id = u and organizacao_id = antiga` por tabela, em ordem alfabética; devolve `{tabela: linhas}` |
| Privilégios | as três funções são **SECURITY INVOKER**: rodam com o papel do backend (`service_role`); a 115 tirou EXECUTE de PUBLIC/anon/authenticated |
| Auditoria | só `plataforma_auditoria` (linha `unidade.transferida_entre_empresas`); nenhuma noção de auditoria imutável de outro módulo |
| Atomicidade/concorrência | a RPC é uma transação; a unidade é travada com `FOR UPDATE` no início; a transferência faz `update unidades` **antes** da varredura, a promoção **depois** |

**Conflito:** com 120–122 aplicadas, a varredura passa a incluir as 13 tabelas financeiras com `unidade_id`. O `service_role` só tem SELECT em `fin_auditoria` (por desenho), e o PostgreSQL verifica o privilégio de UPDATE **mesmo quando nenhuma linha é afetada**. Resultado: `permission denied for table fin_auditoria` em **qualquer** transferência/promoção, inclusive de unidades sem nenhum dado financeiro (reproduzido na cadeia real da `main`: teste "[antes]"). Com dados, a varredura trocaria a empresa de lançamentos e esbarraria nos gatilhos de imutabilidade (auditoria e período fechado). Além disso, os gatilhos de escopo do Financeiro liam a unidade **sem trava**, o que abria uma corrida (ver §3).

## 2. Política implementada
- O histórico financeiro pertence à empresa em que foi registrado e **nunca** muda de empresa por um UPDATE genérico.
- Unidade **sem** nenhuma linha financeira: transferência e promoção funcionam **exatamente como antes**. O retorno e o estado final são idênticos com e sem o Financeiro instalado (teste de equivalência).
- Unidade com **qualquer** linha financeira (lançamento, transferência, período, importação, saldo, referência, resolução, exceção de sangria/fechamento, conta, concessão — mesmo revogada — ou auditoria): **recusa** com `22023`. O backend devolve 400 com a mensagem: *"Esta unidade possui registros no Financeiro (lançamentos: 1, auditoria financeira: 3, …) e não pode ser transferida nem promovida: o histórico financeiro pertence à empresa atual e não muda de empresa. Nada foi alterado."*
- **"Só configuração" (análise separada):** criar conta, exceção de sangria, período ou concessão grava, pelos gatilhos, uma auditoria imutável com a empresa atual. Isso já é histórico, então **também recusa** (cenários 7a–7c). O que **não** bloqueia é habilitar o módulo na unidade (`unidade_modulos`, sem `organizacao_id`): a habilitação acompanha a unidade como antes. Na empresa nova, o Financeiro só abre se ela também tiver o módulo e houver concessão (portão inalterado). Na promoção, a empresa nova herda os módulos da mãe (comportamento da 053).
- Para mover uma unidade com histórico, o caminho seria uma rotina financeira própria (encerrar na empresa A e abrir saldos na B, com trilha). **Não foi implementada**; precisa de decisão de negócio.

## 3. Correção local (arquivos)
| Arquivo | Mudança |
|---|---|
| `database/migrations/120_gestao_financeira_fundacao.sql` §5b | `gestao_financeira_tabelas_da_unidade()`: lista **explícita** das 13 tabelas (não usa prefixo). `gestao_financeira_verificar_unidade_transferivel(uuid)`: guarda INVOKER que trava a unidade (`FOR UPDATE`), conta as linhas da unidade em cada tabela existente e recusa com 22023. **Falha fechada** se o papel não lê alguma tabela por inteiro (sem SELECT ou sujeito a RLS → 42501) ou se o isolamento não é READ COMMITTED (→ 25001). `remapear_organizacao_em_tabelas_de_unidade` **substituída** com a mesma assinatura, retorno, INVOKER e exclusões: chama a guarda antes de qualquer UPDATE e deixa as 13 tabelas fora da varredura. Pré-condição: quem aplica precisa administrar a função (senão aborta sem alterar). Gatilho de concessões lê a unidade com `FOR SHARE`. Pós-condições: anon/authenticated sem EXECUTE na guarda; `remapear…` chama a guarda |
| `database/migrations/121_gestao_financeira_dominio.sql` | `fin_validar_escopo()` lê a unidade com `FOR SHARE`. Pós-condição: guarda da 120 instalada; **nenhuma** tabela `fin_*`/`gestao_financeira_*` com `unidade_id` fora da lista (o prefixo só confere a lista, não a substitui); `service_role` com UPDATE em `unidades` (exigido pelo `FOR SHARE`; o backend já altera unidades com esse papel) |
| `docs/…/proposta-122/122_conciliacao_periodos.provisorio.sql` | mesma conferência da lista (as 4 tabelas da 122 já estão nela) |
| `database/migrations/120_rollback.sql` | recusa se ainda houver tabelas da 121; devolve `remapear…` à definição **exata** da 054 (mesmo md5 e mesma ACL da `main`, provado) e remove guarda e lista |
| `backend/testes-seguros/pg/transferencia_unidades.{sh,sql}`, `stub_supabase_externo.sql` | suíte nova (ver §4) |
| `backend/testes-financeiro-pg/00_stub.sql`, `run.sh`, `backend/testes-seguros/pg/stub.sql` | stubs refletem o Supabase (service_role com UPDATE em `unidades`); `run.sh` aplica a 120 antes da 121 |

**Concorrência (por que `FOR SHARE`):** a transferência trava a unidade com `FOR UPDATE` e a atualiza; o gatilho de escopo agora pega `FOR SHARE` na mesma linha. Se o lançamento chega primeiro, a transferência espera e a contagem da guarda (snapshot novo, READ COMMITTED) o enxerga → recusa (9a). Se a transferência chega primeiro, o lançamento espera e relê a unidade já na empresa nova → `fin_escopo_invalido` (9b). **Controle negativo (9c):** com o gatilho anterior, sem trava, a mesma corrida grava 2 registros da empresa A numa unidade da empresa B. Custo medido: 20 000 lançamentos numa transação levaram ≈ 5,3–5,8 s com o `FOR SHARE` e ≈ 5,0–5,9 s sem (a diferença some no ruído).

**Efeitos de alterar a função compartilhada:**
- (a) `CREATE OR REPLACE` preserva dono e privilégios (inclusive o fechamento da 115).
- (b) `remapear…` passa a depender da guarda: o rollback precisa restaurar a função antes de remover a guarda (já feito na ordem certa).
- (c) Novos erros possíveis numa transferência/promoção: 22023 (histórico financeiro), 42501 (papel sem leitura completa) e 25001 (isolamento ≠ READ COMMITTED); o backend traduz 22023 → 400 e os outros → 500.
- (d) São até 13 `count(*)` por unidade, numa operação administrativa rara; `fin_auditoria` não tem índice começando por `unidade_id` e pode fazer varredura sequencial.
- (e) Escritas financeiras passam a segurar uma trava `FOR SHARE` na linha da unidade até o fim da transação: um `update unidades` do backend na mesma unidade (renomear, ativar, modelo logístico) espera a transação financeira terminar.
- (f) A **ordem** importa: a 121 se recusa a rodar sem a 120 corrigida, e o rollback da 120 se recusa a rodar com a 121 presente (a função da 054 voltaria a quebrar a transferência).

## 4. Testes e resultados (PostgreSQL 17 local descartável)
O banco foi montado a partir do git: as **52 migrations de `origin/main` @ 3545968**, aplicadas como `dono_sim` (não-superusuário, com os default privileges do Supabase), mais um stub mínimo de `auth`/`storage`/`realtime`. Depois, 120 → 121 → 122 (+122 de novo, idempotente).
`PG_CLUSTER_DIR=… bash backend/testes-seguros/pg/transferencia_unidades.sh` → **68 OK, 0 falhas**:

| Pedido | Cenários (OK) |
|---|---|
| reprodução | [antes] unidade sem dado financeiro → `permission denied for table fin_auditoria` |
| 1 transferência sem Financeiro | 1.1–1.8: conclui; iFood (`ifood_conexoes`, `dashboard_ifood_unidade_config`) remapeado; aparelhos do Checklist revogados com `unidade_transferida` (gatilho da `main`); sessões revogadas; `plataforma_auditoria`; depois disso, só a empresa **nova** grava no Financeiro. **Equivalência:** retorno e estado final idênticos sem e com 120–122 |
| 2 promoção sem Financeiro | 2.1–2.3 (veja o defeito pré-existente no §6) |
| 3 lançamentos · 4 transferências · 5 período fechado · 6 auditoria | `.a` transferência e `.b` promoção recusadas com 22023 e a mensagem com a contagem; `.c` **nada mudou** (fotografia de toda tabela com org+unidade, sessões, auditoria da plataforma, número de organizações) |
| 7 só configuração | 7a só conta, 7b só exceção de sangria, 7c só concessão revogada → recusa; 1.6 módulo habilitado → não bloqueia |
| 8 entre organizações | 8.1–8.9: conta/unidade de outro tenant recusadas; UPDATE direto de org recusado; service_role não altera `fin_auditoria`; chamada **direta** de `remapear…` também recusada; anon/authenticated sem EXECUTE; nenhum registro financeiro com empresa diferente da unidade |
| 9 concorrência | 9a, 9b, 9 (consistência) e 9c (controle negativo) |
| 10 falha sem alteração parcial | 10a/10b como RPC real isolada (o `update unidades`, feito **antes** da guarda, também é desfeito; nenhuma organização criada); 10c falha injetada **no meio** da varredura (uma tabela já remapeada volta); 10b.1–10b.3 falha fechada (REPEATABLE READ, papel sujeito a RLS) |
| 11 regressões | rollback 122→121→120 devolve a função **idêntica** à da `main`; reaplicação OK. Suítes existentes: `sim_supabase.sh` 37/37, `ciclo_120_121_122.sh` 18/18, `run.sh` do domínio (todos, inclusive concorrência), `f1_concorrencia.sh` OK, `adversarial122*.sql` 75 PASS, `adversarial122_concorrencia.sh` OK, paridade M1 271/271. T1 do backend: 5 414 testes, **3 falhas = as já conhecidas da `main`** ("distribuições recompõem mês…", "selecionarPerfil (Fase C)" ×2). Testes financeiros 131/131. Frontend 1 530 OK / 0 falhas |

Não executados: `estrutura-organizacional.test.js` e `exclusao-empresa.test.js` exigem o projeto Supabase de testes (0 testes rodaram sem ele); a suíte SQL acima os substitui localmente. `sondagem122.sql` está **desatualizada** desde a O-1 (chama a assinatura antiga de `fin_fechar_periodo`); dá a mesma saída antes e depois desta correção, logo não é regressão.

## 5. Diagnóstico SQL somente leitura do projeto de testes
**Interrompido, conforme a regra:** não existe conexão SQL configurada para `wiqqsxnysbzhcrzrrean` (só REST com chaves `sb_*`). Por isso não foi possível ler as migrations aplicadas, os donos, as policies/RLS, os privilégios efetivos, a definição de `rls_auto_enable` nem os gatilhos de evento. Feito por REST, só com GET da descrição OpenAPI, identidade conferida antes e nenhuma RPC chamada:
- Para o `service_role`, estão expostas `rls_auto_enable`, `transferir_unidade_organizacao`, `promover_unidade_para_empresa`, `remapear_organizacao_em_tabelas_de_unidade`, `converter_empresa_para_unidade` e `excluir_organizacao_definitivamente`.
- Com a chave pública, a OpenAPI devolve **401**: a exposição a anon fica **inconclusiva**.
- `usuarios_organizacoes` tem `perfil_id` ⇒ a 063 foi aplicada ⇒ o defeito de promoção do §6 provavelmente existe também nesse projeto.

## 6. Riscos remanescentes
1. **Defeito PRÉ-EXISTENTE da `main` (independe do Financeiro):** a 063 trocou `unique (usuario_id, organizacao_id)` por `(perfil_id, organizacao_id)`, mas `promover_unidade_para_empresa` ainda faz `on conflict (usuario_id, organizacao_id)`. Toda promoção falha com `42P10` (reproduzido sem 120–122). Nos testes, um índice **local e temporário** devolve a constraint, só para exercitar o resto da promoção. Corrigir isso é uma mudança em outra frente e **não foi feita**.
2. Unidades com histórico financeiro ficam **impedidas** de mudar de empresa até existir uma rotina financeira própria (§2).
3. `excluir_organizacao_definitivamente`: as FKs `RESTRICT` das `fin_*` impedem excluir uma empresa com dados financeiros (falha segura, mas é um resultado novo).
4. A guarda depende de o papel executor contornar RLS (`service_role`/`postgres` no Supabase). Se não contornar, ela falha **fechada**; os atributos reais dos papéis só se confirmam por SQL de leitura ou no T3.
5. A trava `FOR SHARE` serializa escritas financeiras com `update unidades` da mesma unidade (§3e). O custo foi medido em volume, não sob concorrência real de produção.
6. Funções futuras do Financeiro: toda tabela nova com `unidade_id` precisa entrar na lista; a pós-condição da 121/122 recusa a migration se faltar.
7. A revisão independente continua ausente.

## 7. Plano do T3 no projeto de testes COMPARTILHADO (proposta; nada executado)
- **Objetos.**
  - 120: CHECK de `modulos.categoria` (**compartilhado**), 1 linha em `modulos` (**compartilhado**), 2 tabelas e 3 funções `gfc_*`, 2 funções de guarda e a **substituição de `remapear…` (compartilhada)**.
  - 121: 9 tabelas `fin_*`, funções e gatilhos.
  - 122: 4 tabelas, funções e gatilhos.
  - Os gatilhos financeiros passam a ler `unidades` com `FOR SHARE`.
- **Dependências ausentes/não verificáveis.**
  - Drift do projeto (doc 19 §2).
  - Existência de `set_updated_at`, dono de `remapear…` e aplicação da 115 (ACL de `remapear…`): só SQL confirma.
  - A pré-condição da 120 aborta se quem aplica não administra `remapear…`.
- **Efeitos sobre módulos existentes.**
  - Transferência/promoção de unidades **sem** Financeiro: comportamento idêntico (provado).
  - iFood/Checklist: nenhuma tabela deles muda.
  - As suítes `test:estrutura`/`test:exclusao-empresa` precisam de linha de base **antes** (a promoção provavelmente já falha nesse projeto pelo defeito do §6).
- **Semente sintética.**
  - Duas organizações `[T3-FIN]` com ids de prefixo próprio, cada uma com 1–2 unidades.
  - Nenhum vínculo com usuários existentes; módulo habilitado só nelas; concessões só no passo de MFA.
- **Verificação e contenção.**
  1. Antes: contagem por tabela (REST HEAD) e linha de base das suítes de Estrutura.
  2. Depois de cada etapa: contagens das tabelas não financeiras **iguais** (exceção: +1 linha em `modulos`) e `verificacoes_catalogo.sql`.
  3. Transferir uma unidade sintética **sem** Financeiro entre as duas organizações sintéticas (deve passar) e a unidade com Financeiro (deve recusar com 22023).
  4. Nenhum script escreve fora das organizações sintéticas: trocar a trava atual ("nenhuma organização real") por uma **allowlist explícita** de ids sintéticos, recusando escrita fora deles. É uma adaptação a fazer e revisar antes; ela **não** aceita "qualquer projeto existente".
- **Recuperação sem limpeza global.**
  - Antes de qualquer dado: rollback 122 → 121.
  - A 120 **não** volta nesse projeto: mexe em `modulos` (Grupo C). E, depois que a 121 existir, a função da 054 voltaria a quebrar transferências, então a recuperação da função compartilhada é só **para a frente**.
  - Depois de gravar dados: **não assumir rollback**. O esquema financeiro e as linhas sintéticas ficam inertes (o service_role não apaga por desenho). Neutralizar desabilitando o módulo **só** nas organizações sintéticas e inativando-as, com autorização específica.
  - Nunca `truncate`, reset ou `session_replication_role` em massa.

## 8. Autorizações necessárias
1. Aprovar a **política** (§2): recusar mover unidade com qualquer registro financeiro, inclusive "só configuração"; habilitação de módulo não bloqueia.
2. Aprovar a mudança na **função compartilhada** `remapear_organizacao_em_tabelas_de_unidade` e o `FOR SHARE` nos gatilhos (entram junto com a 120/121 em qualquer banco).
3. Decidir sobre o **defeito pré-existente da promoção** (§6.1): abrir uma correção separada na frente de Estrutura Organizacional ou aceitá-lo.
4. Fornecer, por variável de ambiente (sem colar no chat), uma **conexão SQL somente leitura** ao projeto de testes, para completar o diagnóstico do §5.
5. Para o T3 compartilhado: autorizar, em etapas, (a) a adaptação das travas para allowlist sintética, (b) a aplicação 120 → 121 → 122 numa janela sem outras suítes rodando, (c) a semente sintética e (d) aceitar que o esquema e os dados sintéticos **permaneçam** no projeto.

## 9. Complemento (Agente 2, 2026-10-19) — verificação própria e brecha fechada
Revisei a §5b e reproduzi a suíte na branch `final/financeiro` (não é revisão independente: passei a ser o único executor).
- **Brecha encontrada:** a guarda só valia para `transferir`/`promover`/`remapear`. Um `UPDATE` **genérico** de `unidades.organizacao_id` (ex.: PostgREST com `service_role` ou SQL avulso) mudava a unidade de empresa e deixava o histórico financeiro órfão na empresa antiga. Provado: `transferencia_unidades.sql` 8.10 e 8.13 **FALHA** antes.
- **Correção (120 §5b):** gatilho `trg_unidades_guarda_financeiro` (`BEFORE UPDATE OF organizacao_id ON unidades`) → `gestao_financeira_unidades_guarda_org()` → mesma guarda (só quando a empresa **muda**). Pós-condição da 120 exige o gatilho; o rollback o remove antes da guarda. Na transferência pela RPC o erro é o mesmo (22023 com a contagem), só que já no `update unidades`.
- **Depois:** 8.10–8.13 OK (UPDATE direto com histórico recusado; sem histórico continua permitido; outras colunas da unidade continuam editáveis) e nova verificação do ciclo: "gatilhos de unidades: a 120 acrescenta a guarda e o rollback devolve exatamente os da main". Suíte: **73 OK, 0 falhas**.
- **Efeito colateral aceito:** um `UPDATE` de `organizacao_id` feito em REPEATABLE READ/SERIALIZABLE agora recusa (25001), como já acontecia na RPC; e um papel que não lê as tabelas financeiras por inteiro falha fechado (42501). Nenhum código da aplicação muda `unidades.organizacao_id` fora das RPCs (verificado: só `ativo`, `modelo_logistico_ifood` e tabelas comerciais).
- `converter_empresa_para_unidade` não precisa da guarda: só converte empresa **sem** unidades (logo, sem linha financeira de unidade).
- No banco de testes compartilhado (doc 21), os corpos de `remapear`/`transferir`/`promover`/`converter`/`excluir` são **idênticos** aos da `main` (md5 normalizado), então a substituição da 120 parte do mesmo código que foi testado aqui.
