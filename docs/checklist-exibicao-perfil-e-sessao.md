# Checklist via HDMI — conta de exibição e duração da sessão (Checkpoint 6B)

> **Status:** implementado e testado localmente; **nada aplicado em produção** (migrations 112/113 preparadas, não
> aplicadas; nenhuma variável alterada; nenhuma integração ligada). A parte de **renovação de sessão NÃO foi
> implementada**: depende de decisões de segurança listadas na seção 4.

## 1. O que existe agora

O computador ligado à TV da loja entra com uma **conta dedicada**, com o papel **Operador de Exibição**
(`display_operator`) e UMA permissão (`checklist.visualizar`).

| Camada | O que faz |
|---|---|
| Permissão | `checklist.visualizar` é a única do papel. Todo papel que já abria o Checklist a recebe junto com a leitura (ninguém perde acesso). |
| Rota do Checklist | aceita `checklist.visualizar` **ou** `integracoes.ver`. O "ou" existe só porque a lista de permissões fica **congelada** na sessão (≤ 8 h): sessões abertas antes do deploy não têm a permissão nova. Depois de ≥ 8 h do deploy dá para tirar o "ou". |
| Bloqueio "nega tudo, exceto a lista" | `restringirPerfilExibicao`, logo depois do `requireContexto`: o perfil só alcança `GET /checklist-operacional/resumo` e `POST /realtime/credencial`. **Todo o resto é 403**, inclusive rota futura que esqueça de exigir permissão. |
| Seleção de contexto | o papel só vale como vínculo **direto de UMA unidade**. Consolidado, outra unidade, outra empresa e papel herdado de vínculo de empresa são recusados com a mesma mensagem do "sem acesso". |
| Banco | migration 113: `usuarios_organizacoes` não aceita o papel (constraint). |
| Realtime | a credencial do perfil autoriza **só** `unidade:<id>` (nunca `empresa:<id>`). |
| Painel SuperAdmin | o papel é de **unidade** (nunca de empresa) e a conta é **exclusiva**: com o papel de exibição não pode ter vínculo de empresa nem outro cargo, e quem já tem empresa não pode recebê-lo (409). |
| Frontend | menu só com o Checklist; sem troca de empresa/usuário, sem atualizar dados, sem alertas, sem Agente; entrada (login, reinício do navegador, reentrada) cai no Checklist; nenhuma carga que o backend recusaria. |

### Permissões

| Concedida | Negada (403) |
|---|---|
| `checklist.visualizar` → `GET /checklist-operacional/resumo` da **própria unidade** | Financeiro, Vendas, CMV, Produtos, Insumos, Dashboard, Dashboard iFood, Bonificação, Parser, Usuários, Configurações, lista de pedidos e status do iFood, Martin Brower, Inteligência, Agente, Unidade, Painel SuperAdmin, Painel Administrativo, legado `/contexto` |
| `POST /realtime/credencial` (só canal da unidade) | modo consolidado, outras unidades, outras empresas, qualquer escrita |

> **Achado pré-existente (fora do escopo do 6B, não alterado):** várias rotas do tenant (produtos, CMV, dashboard,
> vendas, Martin Brower, inteligência, agente) **não exigem permissão no roteador**, só módulo + contexto. Para os
> papéis atuais isso já é assim; é por isso que o perfil de exibição **não** depende de cada rota: o bloqueio acima
> é a trava. Vale uma auditoria própria (checkpoint separado).

## 2. Como criar a conta da TV (roteiro — exige autorização para aplicar migrations)

1. **Migrations, em ordem e já aprovadas:** `112` (valor do enum — **sem** begin/commit) e depois `113` (constraint).
   A 113 só pode rodar depois que a 112 foi **commitada**. Rollbacks: `113_rollback.sql`, `112_rollback.sql` (aborta
   se alguém ainda usa o papel; o Postgres não remove valores de enum).
2. Deploy do código (pode ir antes ou depois das migrations; sem a 112 o painel não consegue gravar o papel).
3. No Painel SuperAdmin: criar a **conta** (e-mail próprio da loja, senha forte e única) e, no detalhe dela, clicar
   **"+ Acesso de exibição (TV)"** → escolher empresa e unidade. A conta deve ter **um** perfil (sem PIN).
4. No computador da TV: perfil de navegador **exclusivo**, login com essa conta, abrir o Checklist, escolher o modo.
5. **Desligar a TV de um dia para o outro:** "Sair" no menu do usuário, ou **Forçar logout** no painel (derruba em
   até ~30 s, no próximo polling). **Bloquear conta** impede também novas seleções.

## 3. Duração da sessão — o que o código faz hoje (verificado)

* O **Context Token vale 8 h ABSOLUTAS** (`VALIDADE_PADRAO_S`) e a linha em `sessoes_contexto` tem o mesmo prazo.
  Não há renovação (exceto o perfil de exibição — ver 3b) nem expiração por ociosidade; o polling de 30 s **não** estende a sessão.
* O **login do Supabase** (`persistSession` + `autoRefreshToken`, em `localStorage`) é separado e se renova sozinho; o
  contexto da unidade fica em `sessionStorage` (some ao fechar a aba).
* Ao vencer, o próximo polling recebe **409** → o modo fecha e remove o painel da página → a Central tenta reentrar.
  Para a conta de exibição (um único acesso) **reentra sozinha, sem senha**. Antes do 6B isso caía na página inicial
  da Central; **agora cai no Checklist** (testado em navegador). A tela cheia continua exigindo **um clique** (regra
  do navegador; não há como contornar).
* Consequência: as 8 h **não** obrigam a digitar senha de novo; a fronteira real é a vida do refresh token do
  Supabase (configuração do projeto — **não verificada**).

## 3b. Renovação automática para o expediente de 17 h (Adendo do 6B.1 — IMPLEMENTADA, só local)

**Escopo:** exclusivamente `display_operator`. As sessões dos demais papéis, administrativas e de impersonação **não
mudam** (validade 8 h absoluta) e **não podem** renovar (403 e a sessão fica intacta). Nenhuma validade global foi alterada.

**Fluxo.** `POST /api/v1/sessao/renovar` (sem corpo; exige login + Context Token válidos; limite de taxa por conta):

1. A conta, a empresa, a unidade e o perfil vêm da sessão **já validada no servidor** — nada do que o navegador mandar
   (corpo, relógio, prazo) é considerado.
2. **Janela:** só renova quando falta menos de 2 h para o contexto vencer; antes disso responde `200 {renovado:false}` e
   não altera nada. O navegador pede ~1 h antes do vencimento (± 5 min de espalhamento, medindo no **relógio do
   servidor**, recebido com o prazo), então a renovação sai aos ~7 h e ~14 h.
3. **Limite absoluto = 20 h desde a AUTENTICAÇÃO do Supabase** (carimbo `amr[].timestamp` do JWT), não desde o contexto
   — senão a reentrada sem senha reiniciaria o limite. Passou do limite (ou faltam < 60 s): `401 REAUTENTICACAO_NECESSARIA`;
   a reentrada (`/sessao/selecionar`) também exige JWT mais novo. Perto do limite, o contexto novo sai **encurtado até o limite**.
   **Sem o carimbo no JWT: não renova** (fail-closed; vale o comportamento antigo de 8 h).
4. **Revalidação completa** pelo mesmo caminho da entrada (`selecionarContexto`): conta ativa, perfil ativo, vínculo
   ativo, unidade ativa, empresa não bloqueada, módulos e permissões **recalculados**. Papel alterado/vínculo de empresa
   surgido ⇒ negado (nunca amplia permissões). Em 403 o contexto antigo é revogado; em falha transitória (5xx/rede) o
   antigo é restaurado e dá para tentar de novo.
5. **Concorrência:** troca atômica por compare-and-set na linha da sessão (`motivo_revogacao IS NULL → 'renovada'`):
   N renovações simultâneas ⇒ **uma** vence (201), as outras `409 RENOVACAO_CONCORRENTE`. O token antigo fica válido só
   por **90 s** (cobre requisições em voo) e **não pode ser renovado de novo** (proteção contra reutilização).
6. **MFA:** `MFA_ENFORCE_EXIBICAO=true` (dormente por padrão) exige `aal2` para entrar **e** para renovar (`401 MFA_REQUERIDA`).
7. **Auditoria:** `sessao.contexto_renovado` e `sessao.contexto_renovacao_negada` (ids de sessão, prazos e motivo; **nenhum
   token**). Testado: nenhum Context Token nem JWT aparece nas linhas de auditoria.

**No navegador** (`renovacaoContexto.js`): troca só o token e o prazo, **sem** subir a geração do contexto — o Modo
Televisão, o polling e a tela cheia seguem como estão (testado: mesmo elemento do painel após 17 h). Falha de rede: nova
tentativa com espera crescente (30 s → 5 min) enquanto o contexto atual vale; 401/403/409 param o agendamento e seguem o
fluxo normal da Central. Se o servidor devolver qualquer identidade diferente, o navegador **não adota** o token.

**Parâmetros (env, com limites duros):** `RENOVACAO_EXIBICAO_LIMITE_S` (20 h; 10 min–24 h), `_JANELA_S` (2 h), `_GRACA_S` (90 s),
`_MINIMO_S` (60 s), `RATE_LIMIT_RENOVAR_MAX` (40/h). Nenhum precisa ser definido para funcionar.

**Pressuposto ainda NÃO validado:** que os JWTs reais do Supabase trazem `amr[].timestamp` (padrão do GoTrue). Os testes
usam JWTs com essa claim. **Validar em homologação** antes de contar com as 17 h; se faltar, o sistema cai em 8 h (seguro).
Outro ponto de homologação: duas abas da mesma conta — a que perde a corrida recebe 409 e reentra sozinha (testado).

### 3c. Expediente 11h–04h e procedimento operacional (Checkpoint 6B.2)

O limite de 20 h conta desde a **autenticação** (login), não desde o início do turno. Simulado com a cadeia real:

| Quando a conta autenticou | Limite absoluto | Cobre 11h–04h? |
|---|---|---|
| 11h (início do turno) | 07h do dia seguinte | **Sim**, com 2 renovações (~18h e ~01h), sem interrupção |
| 09h (2 h antes) | 05h | **Sim** |
| 08h (3 h antes) | 04h | **Sim, no limite** (margem zero) |
| 06h (5 h antes) | 02h | **Não** — o Checklist para às 02h; só volta com login novo |

**Procedimento operacional (regra de ouro):** *entre com a conta da TV na hora de abrir a loja — no máximo 2 h antes do
turno (margem de 1 h)*. Se a TV ficou logada de véspera ou desde cedo, **saia e entre de novo** na abertura (sair → entrar
renova o carimbo de autenticação). Se o turno passar do limite mesmo assim: às 02h (ou quando o limite chegar) a TV mostra
o **login**; quem estiver na loja entra de novo (usuário e senha da conta da TV), abre o Checklist e escolhe o modo + tela
cheia — o turno segue até o fim (testado: login às 02h05 cobre até 04h). **Não existe renovação infinita**: depois do
limite, renovar e reentrar com o mesmo login são sempre recusados (`REAUTENTICACAO_NECESSARIA`).

A renovação perto do limite **encurta** o contexto até ele (não ultrapassa as 20 h); a TV nunca fica com um contexto que
valha mais que o limite.

### 3d. Conta bloqueada no meio do turno (6B.2)

O backend marca o 403 de conta inativa com `details.codigo = "CONTA_INATIVA"` (o texto continua o mesmo). O frontend trata
**só esse código**: encerra o contexto (fecha o Modo TV e remove os dados da tela), derruba o login local e mostra o login
com o motivo — **sem reentrada automática**. Vale no polling e na renovação (testado em navegador real). Qualquer outro 403
(falta de permissão) segue como erro comum e não desloga ninguém. Observação: se o bloqueio for feito direto no banco (não
pelo painel), a linha da sessão não é revogada, mas fica inutilizável (o servidor recusa a conta); pelo painel
("Bloquear conta") as sessões são revogadas.

### 3e. Duas abas (6B.2)

Aba duplicada (`window.open` copia o `sessionStorage`) parte do **mesmo** contexto. Se as duas renovam juntas: **uma** vence
(a troca é atômica), a outra recebe 409, perde a renovação e, passada a graça de 90 s, cai no 409 do contexto e **reentra
sozinha** pelo caminho normal (nova seleção, com revalidação completa). Nenhuma aba ganha permissão além de
`checklist.visualizar`; a sessão revogada **nunca** é ressuscitada pela renovação (a linha segue revogada com o motivo original).

### 3f. Verificação do JWT real do Supabase (6B.2)

* **Documentação do Supabase** (Claims Reference / tipos do `supabase-js`): `amr` é uma lista de `{ method, timestamp }`
  com `timestamp` em **segundos** desde a época; há uma variante só de strings (via hooks) — nesse caso **não há carimbo**
  e o sistema cai no comportamento seguro de 8 h (testado). Isso é o que o código lê (`carimboDeAutenticacao`).
* **Não foi verificado com um token real**: não usei credenciais de produção. Para verificar sem expor o token, use
  `backend/scripts/verificar-jwt-amr.mjs` (lê o token pela entrada padrão, imprime só nomes de claims, formato do `amr` e
  idades em minutos; **nunca** imprime o token). Rode uma vez logo após o login e outra ≥ 1 h depois (após um refresh): o
  "autenticado há" deve **continuar contando desde o login**. Se reiniciar a cada refresh, a janela de 20 h seria renovada
  pelo refresh e a política precisa ser revista antes de publicar.

### 3g. Revisão de segurança final da renovação (6B.3)

| Requisito | Conclusão | Onde está provado |
|---|---|---|
| Não renova sessão administrativa pelo fluxo de exibição | **Sim.** Só `display_operator`, nunca impersonação, e exige unidade; superadmin/painel/gestor/admin/financeiro/operação/consulta → 403 e a sessão fica **intacta** | `renovacao-exibicao-cadeia-real-pg` (papéis; impersonação; serviço sem tocar no banco) |
| Teto efetivo de 20 h | **Sim, desde que o carimbo seja estável** (ver 3f): o contexto nasce e renova **encurtado** até o limite; depois, renovar e reentrar com o mesmo login são recusados | `…expediente-abas-real-pg`, `…cadeia-real-pg` |
| Revogação imediata | Sim: revogada/bloqueada/unidade desativada/vínculo removido/papel alterado → renovação negada; 403 revoga o contexto antigo; a renovação nunca ressuscita sessão revogada | idem + `perfil-exibicao-interface-real-pg` |
| MFA | A política vigente **não foi alterada** (o perfil de exibição não exigia MFA e continua assim). `MFA_ENFORCE_EXIBICAO=true` (dormente) exige `aal2` para entrar **e** renovar. A renovação **não dispensa** nenhuma exigência existente | `…cadeia-real-pg` (MFA) |
| Isolamento por unidade | Empresa/unidade/perfil vêm da **linha da sessão**, nunca do corpo; identidade pós-revalidação conferida; Realtime só do canal da unidade | `…cadeia-real-pg` (corpo ignorado), `perfil-exibicao-rotas-fora-do-tenant-real-pg` |
| Permissões indevidas | Recalculadas a cada renovação (não copiadas); papel alterado/vínculo de empresa novo ⇒ negado; deny-by-default do perfil de exibição | `perfil-exibicao-isolamento`, `…cadeia-real-pg` |
| Credenciais nos registros | Auditoria só com ids/motivos/prazos; nenhum Context Token nem JWT; o script de verificação nunca imprime token nem valores de claims | `…cadeia-real-pg` (auditoria), `verificar-jwt-amr-script.test` |
| Sem renovação infinita por refresh do Supabase | **Depende do pressuposto não validado**: o limite conta do `amr[].timestamp`, e o JWT é **validado pelo Supabase antes** de qualquer claim ser lida (`requireAuth` → `getUser`) — não dá para forjar o carimbo. Se o refresh **reiniciar** esse carimbo, o teto deixa de valer | **PENDENTE** (3f) |

**Achado novo, de segurança (ainda não corrigido em produção) — RLS cego ao papel.** As policies `rls_*_tenant`
(migration 016/000) liberam a `authenticated` **todas** as linhas das tabelas de unidade (vendas, estoque, notas,
bonificação, alertas, divergências…) a quem tem **vínculo ativo** em `usuarios_unidades`, via `auth_unidade_ids()`,
sem olhar o papel, e várias são `for all` (leitura **e** escrita). O backend usa `service_role` e não passa por isso,
mas a chave `anon` é pública e o JWT da conta da TV fica no navegador da loja: a conta de exibição poderia falar
**direto** com a API REST do Supabase e furar o "só Checklist". Reproduzido em Postgres descartável (desenho idêntico
ao real): sem a correção a conta lê e escreve; com ela não enxerga nada. **Correção proposta, preparada e NÃO aplicada:**
`114_rls_exclui_papel_exibicao.sql` (+ rollback) — um único ponto, `auth_unidade_ids()` ignora vínculos de
`display_operator`; nenhuma policy muda; os demais papéis ficam iguais (testado, inclusive "herda da empresa").
Pré-requisito: 112 commitada. **Não verificado em produção** (grants/exposição do PostgREST do projeto real). Observação:
o mesmo desenho deixa qualquer papel (ex.: consulta) escrever direto nas tabelas `for all` — pré-existente e fora do 6B;
merece auditoria própria.

### 3h. Preparação para consolidação (6B.3) — não é autorização para publicar

* **Base:** `feat/checklist-perfil-exibicao` estava em `2d588a2` = `origin/main`; em 11/10 o `origin/main` avançou 2 commits (`e3a582f`, PR #37 — Events do iFood restritos às unidades do piloto; **sem sobreposição** com os arquivos do 6B e sem migration nova) — antes de consolidar, rebasear/merge e reexecutar as suítes. O
  `main` local da pasta principal está desatualizado (`af46fbf`): consolidar sempre a partir de `origin/main`.
* **Conteúdo:** 22 arquivos modificados + ~38 novos, **nada commitado**. Sem CRLF nos novos (repo é LF).
* **Conflitos esperados:** só com o 5C, ainda não consolidado e com alterações locais em `routes.js` (+7 linhas: monta
  `/checklist-operacional/telas`) e `permissoes.js` (+4: `checklist.telas.gerenciar`). São hunks vizinhos, resolução
  textual simples. Funcionalmente seguro: o restritor do perfil de exibição fica **antes** das rotas do tenant, então
  `/checklist-operacional/telas` também é negada à conta da TV. As migrations do 5C (`110`, local `111`) são independentes das nossas (112–114).
* **Migrations (SHA-256, primeiros 16):** 112 `7bc063d2f51cf057` · 112_rollback `f08c358cb10c99a5` · 113 `9d28ce7a4aa86b8c` ·
  113_rollback `3eccb1641d74deff` · 114 `fd3cc3279c5c2123` · 114_rollback `8786d235e2cabec1`.
* **Dependências:** enum `papel_acesso` (015), `usuarios_organizacoes`/`usuarios_unidades` com `papel` (015/000), função
  `auth_unidade_ids()` (015/000). Nenhuma migration anterior pendente: o último número no `origin/main` é 110.
* **Ordem segura (futura):** 112 (commit) → 113 → 114 → deploy backend → deploy frontend → validar JWT real → criar a conta da
  TV → piloto de 17 h → só depois remover o "ou `integracoes.ver`".
* **Testes depois de um eventual merge:** backend completo (`test/*.test.js` com `SUPABASE_*` fictícios) + os `*-pg` com
  Postgres descartável + navegador; frontend completo; as 5 falhas conhecidas da base devem continuar sendo as únicas.

### 3i. Acesso direto ao Supabase e migrations 114/115 (6B.4)

Auditoria completa, matriz por papel e plano em **`docs/seguranca-acesso-direto-supabase.md`**; procedimento seguro de verificação do JWT em
**`docs/verificacao-jwt-supabase-conta-teste.md`**. Resumo: sem a 114 a TV lia 27 tabelas e alterava 26 pela API REST; com a 114 **zero**,
e os demais papéis ficam idênticos. A 114 sozinha **não basta**: 4 views sem `security_invoker`, a tabela `unidade_config` sem RLS e 7 RPCs de negócio
continuam alcançáveis (pré-existente, vale até para `anon`) — fechados pela **115** (proposta, testada, **não aplicada**).
Ordem: **112 → 113 → 114 → 115**, depois backend e frontend. Rollbacks na ordem inversa.

## 4. Opções históricas (6B) — a **B** foi implementada acima; mantidas só como registro

| | Opção | O que muda | Segurança | Custo operacional |
|---|---|---|---|---|
| **A** | Manter 8 h + reentrada automática (**é o que existe**) | nada | menor janela de uso do contexto | 1 clique (modo + tela cheia) a cada ≤ 8 h |
| **C** | Validade **só do papel de exibição** maior (ex.: 12 h) | um parâmetro na emissão do contexto, só para esse papel | janela maior, mas conta de baixo privilégio, só leitura, 1 unidade | cobre um expediente de 10–12 h sem intervenção |
| **B** | **Renovação deslizante** só para o papel de exibição | endpoint novo de renovação + token novo | exige as proteções abaixo | zero intervenção enquanto o computador estiver ligado |
| **D** | Reautenticação programada (ex.: virada às 05:00) | procedimento, sem código | a mais restritiva | um login por dia |

**Se escolherem B, ela precisa de TODAS estas proteções** (por isso não foi implementada sem decisão):
1. Só renova se a **sessão anterior não foi revogada**, o **usuário está ativo**, o **vínculo está ativo**, a **empresa
   não está bloqueada** e o **papel continua sendo o de exibição**.
2. **Não ignorar MFA exigido**: respeitar o nível `aal` do login quando o MFA estiver ligado para a conta.
3. **Teto absoluto** (ex.: 14–16 h desde a última autenticação) e **limite de renovações**: nunca sessão permanente.
4. **Rotação**: cada renovação cria uma sessão nova e revoga a anterior (token velho deixa de valer — proteção contra
   reutilização), sem tocar nas sessões irmãs (Model Y).
5. **Auditoria** de cada renovação (quem, quando, IP) e de cada recusa.
6. **Limite de taxa** e resposta única para qualquer recusa.
7. **Sessão Supabase expirada** continua levando ao login (a renovação do contexto não renova o login).
8. Testes de revogação concorrente (renovar durante a revogação não pode ressuscitar a sessão).

**Recomendação:** **A agora**; **C** como primeira mudança de código se uma loja operar mais de 8 h seguidas (menor
mudança, sem endpoint novo); **B** só se C não bastar.

**Decisões que dependem de vocês:** (1) validade para o papel (se C); (2) exigir ou não MFA na conta da TV (com MFA, cada
reentrada pede o fator e a TV deixa de se recuperar sozinha); (3) teto absoluto e política de renovação (se B);
(4) quem fica responsável por revogar/reativar a conta; (5) tirar o "ou `integracoes.ver`" da rota do Checklist
depois de ≥ 8 h do deploy.

## 4b. Publicação segura das migrations 112/113 (auditadas em Postgres 17 local; Supabase de produção NÃO consultado)

* **Dois arquivos, duas transações, nesta ordem.** Aplicar 112 + 113 numa só transação **falha** (`unsafe use of new value …
  of enum type`) e desfaz tudo — testado. O runner do Supabase executa cada arquivo na própria transação: ok.
* **112** (`ALTER TYPE … ADD VALUE IF NOT EXISTS`): idempotente, instantânea, não toca em dado. O valor do enum **é permanente**
  (o Postgres não remove valores); o rollback só confere que ninguém usa e aborta se usarem.
* **113** (constraint em `usuarios_organizacoes` + índice único parcial em `usuarios_unidades`, "uma unidade por conta de
  exibição"): `lock_timeout` de 5 s — com transação longa segurando a tabela **falha em ~5 s sem aplicar nada** e sem prender
  os logins atrás dela (testado); basta repetir. Idempotente e segura sob aplicação simultânea (advisory lock).
* **Compatibilidade:** com todos os papéis antigos cadastrados, 112 + 113 **não alteram nenhuma linha**; usuários antigos
  continuam podendo ter várias unidades (o índice só vale para o papel novo). Dados existentes não violam nada (o valor nem existia).
* **Ordem do deploy:** migrations **112 → 113 → 114 → código** é a mais simples (sem a 112 o painel não consegue gravar o papel e o
  app novo não pode ir antes dela). Código antes das migrations também é seguro (a conta de exibição só nasce pelo painel).
  O "ou `integracoes.ver`" da rota do Checklist continua até todas as lojas operarem com o código novo (≥ 8 h).
* **Rollback, nesta ordem:** `113_rollback` (remove constraint e índice) → `112_rollback` (aborta se ainda há vínculo com o papel).
* **Código novo × banco sem a 112 (revisado no 6B.2):** a lista de Usuários consulta o papel de exibição de forma tolerante
  (se o valor do enum não existe, ninguém é "conta de exibição" e a lista não cai); o resto do código só usa o valor ao
  criar/entrar numa conta de exibição, que não existe antes do painel gravá-la.
* **Checklist para a publicação futura (nada disto foi feito):** (1) autorização explícita; (2) backup/ponto de restauração;
  (3) 112 → conferir commit → 113 (cada uma no seu arquivo, janela de baixa carga; se a 113 falhar por `lock_timeout`, repetir);
  (4) deploy do backend e **depois** do frontend (o frontend novo chama `/sessao/renovar` e lê `contaExibicao`; backend antigo
  responde 404: o renovador repete com espera crescente e desiste ao vencer o contexto, sem efeito além de requisições — seguro); (5) validar o JWT real com `verificar-jwt-amr.mjs`; (6) criar a conta da TV
  e fazer o teste de 17 h na loja piloto; (7) só então, remover o "ou `integracoes.ver`" da rota do Checklist (≥ 8 h depois).
* **Provisionamento:** conta própria da loja → "+ Acesso de exibição (TV)" → perfil de navegador exclusivo na TV.

## 4c. Achados da validação final (6B.1)

* **Corrigido:** o detalhe do usuário mostrava, para o vínculo de exibição, um seletor com "Herdar da empresa" e cargos de
  empresa (o papel de exibição nem era opção). Agora é um rótulo fixo "Operador de Exibição" (teste em navegador, vermelho antes da correção).
* **Corrigido no 6B.2:** conta bloqueada no meio do turno (ver 3d) e aviso "sem empresa" da lista de Usuários, que agora não conta
  nem marca como pendente a conta de exibição (só-unidade; etiqueta "Exibição (TV)"); as demais contas seguem como antes.
* **Comportamento aceito:** o administrador (SuperAdmin) pode **trocar o cargo** de uma conta de exibição para outro cargo de
  unidade (reaproveitamento da conta; o papel muda por inteiro e a sessão cai). Não é acúmulo; voltar a exibição também funciona.
* **Rotas do tenant sem exigência de permissão no roteador:** ver `docs/achado-rotas-tenant-sem-permissao-explicita.md`
  (documentado, sem refatoração; o perfil de exibição é barrado antes de chegar nelas).

## 5. Riscos que continuam

* O papel de exibição vê o **número curto** dos pedidos e os indicadores da unidade: é a função do painel.
* O login do Supabase fica no `localStorage` do computador: a conta da TV deve usar perfil de navegador **exclusivo**
  (fora disso, quem usa o computador usa a conta).
* Sem Events do iFood ligados, o painel mostra "recebimento não ativado" (nenhum dado simulado como real).
* Rotas do tenant sem permissão no roteador (achado acima): não afetam o perfil de exibição, mas merecem auditoria.
