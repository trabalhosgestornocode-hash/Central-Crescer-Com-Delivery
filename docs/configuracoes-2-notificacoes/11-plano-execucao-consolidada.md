# 11 — Plano final de execução consolidada (Etapas 1–5)

> Plano para **uma** execução do Claude Code. Incorpora as decisões aprovadas: preservação dos legados (`LEGACY_ACTIVE`), D-16 (congelamento na ativação M3), D-3, D-4, D-9, D-11, D-14 e D-15.
> **Esta execução não altera produção, não aplica migrations em ambiente real, não faz merge nem deploy, não envia WhatsApp nem OTP real e não ativa a M3.**

## 1. Invariantes (critério de parada: se algum for violado, a execução para e reporta)

1. **D-1 idêntico.** Os mesmos destinatários, mensagens, `idempotency_key`, conteúdo byte a byte, `disponivel_em`/`expira_em`, cotas, cooldowns, reforço e aviso tardio, com a seleção nova desligada (padrão) **e** na equivalência da ativação M3 (doc 07 §1.1–1.2).
2. **Legados:** `LEGACY_ACTIVE` só para `pendencia_d1`; nenhuma evidência fabricada; nenhuma categoria nova automática; revogação e bloqueio antes de qualquer envio, inclusive já enfileirado.
3. **Transferência de unidade continua funcionando** (harness `transferencia_unidades.sh` e `transferencia_checklist_metas.sh` verdes), **sem tocar** `remapear_organizacao_em_tabelas_de_unidade` (D-11).
4. **Isolamento:** nada entre empresas; nada indevido entre unidades (D-3), garantido em backend **e** banco.
5. **Nenhum transporte real:** OTP e notificações novas só com `noop`; teste arquitetural proíbe OTP via Baileys e qualquer import do gateway nos módulos novos.
6. **Segredos:** nenhum número completo, código OTP, token ou segredo em log, auditoria, resposta comum da API ou repositório (o repositório é público).
7. **Outras frentes preservadas:** nenhum arquivo de outra frente é alterado sem necessidade comprovada. Conflitos com o Financeiro (migration 120/função de transferência) são **reportados, não resolvidos por sobrescrita**.

## 2. Pré-voo da execução

- `git fetch`. A base é `origin/main` atualizada (hoje `9da8210`). Criar o worktree `crescer-config2-impl`, branch `feat/configuracoes-2-central-notificacoes`. O checkout principal e os demais worktrees ficam intocados.
- Trazer os docs desta auditoria (`docs/configuracoes-2-notificacoes/`, branch `docs/configuracoes-notificacoes`) por cherry-pick.
- **Reconfirmar a numeração** de migrations em todas as branches (hoje a última é 131; nenhuma usa 132+). Reservar 132–135.
- Reconferir se a função de transferência mudou na `main` ou se o Financeiro publicou a alteração pendente (`5233380`). O desenho não depende disso, mas o harness precisa rodar com a versão vigente.
- **Linha de base:** regressão completa do backend na `main` (matriz como no PR #54: 14 falhas preexistentes conhecidas, sendo 11 da Central por bomba-relógio de data, `performance-calc` e `sessao-perfil` ×2) e navegador (Parser 9/10 preexistente).

## 3. Blocos de trabalho (ordem)

### B1 — Fundação de segurança (D-4)

- `backend/src/shared/cripto.js`: generalizar (`criarCifra({ chave })`) **sem** mudar o comportamento atual do iFood (`IFOOD_TOKEN_SECRET`). Os testes atuais do iFood continuam verdes.
- `backend/src/modules/notificacoes/notificacoes.segredos.js`:
  - HKDF de `NOTIFICACOES_SEGREDO_MESTRE` em três subchaves: `cifra`, `hmac_id` e `hmac_otp`;
  - `cifrarTelefone`/`decifrarTelefone` (AES-256-GCM, IV aleatório, `chave_versao`), `hmacTelefone`, `hmacOtp`, `compararSeguro` (`timingSafeEqual`);
  - boot fail-closed **só** quando a Central estiver habilitada.
- Logger seguro com bloqueio de E.164, código de 6 dígitos em contexto de OTP, tokens e segredos (padrão `worker-comunicacao.logsafe.js`).
- **Teste arquitetural:** só `notificacoes.envio.js` e `notificacoes.destinatarios.edicao.js` importam `decifrarTelefone`.

### B2 — Configurações 2.0 (Etapa 1), Usuários (D-14) e fuso (D-15)

- **Frontend:**
  - `frontend/src/configuracoes/` dividido por categoria (`index.js` com navegação lateral/celular e rota por seção; `unidadeEmpresa.js`, `metasOperacao.js`, `notificacoes/*.js`, `usuariosAcesso.js`, `integracoes.js`, `segurancaPrivacidade.js`, `preferencias.js`) e `configuracoes.css`;
  - `configuracoes.js` vira fachada **mantendo** `renderConfiguracoes`, `abrirSecaoConfiguracoes(id)` e `aplicarTemaSalvo` (usados por `app.js`/Dashboard iFood).
- **Usuários (D-14, APROVADA):**
  - "Conceder acesso" passa a **convidar por e-mail**;
  - o campo de senha some da interface e dos logs;
  - ações só aparecem com `usuarios.gerenciar`;
  - conta existente recebe só o vínculo (como hoje), sem senha;
  - conta nova recebe o convite.
- **Backend `usuarios`:**
  - `usuarios_convites`: token de 32 bytes, SHA-256 armazenado, 72 h, uso único atômico;
  - provedor de e-mail abstrato: `supabase_auth` (`inviteUserByEmail` com `redirectTo` para a página de aceite) e `fake` nos testes;
  - o aceite valida token, empresa e unidade (mesma empresa ainda) e só então cria o vínculo;
  - usuários, sessões e acessos existentes ficam intocados;
  - a rota antiga com senha continua no Painel SuperAdmin (fora do escopo do cliente).
- **Fuso (D-15, APROVADA):**
  - `unidades.timezone` (IANA validado contra `Intl.supportedValuesOf('timeZone')` no backend e lista fixa no banco via `CHECK` de função) e `horario_funcionamento`;
  - data de corte em `comunicacao_configuracoes['fuso_unidade_corte']` (nula = recurso desligado);
  - `resolverFuso()` (`checklistOperacional.operacional.service.js:58`) passa a `resolverFuso({ unidade, competencia })`: competência ≥ corte e unidade com fuso → `{ fuso: unidade.timezone, origem: 'unidade' }`; caso contrário `{ FUSO_NEGOCIO, 'padrao_plataforma' }`;
  - fechamentos já gravados **não** são reprocessados (versões imutáveis guardam `fuso`/`fuso_origem`);
  - o agendador usa o fuso por unidade.
  - **Dependência DEP-3:** os períodos do Dashboard 2.0 da mesma unidade precisam usar o mesmo resolvedor para manter "mesmos números" (invariante do PR #54).
- **Migration `132_configuracoes2_unidade_fuso_usuarios_convites`** + rollback.

### B3 — Central de Notificações: esquema, permissões, legados (Etapa 2)

- **Migration `133_notificacoes_escopos_snapshot`** + rollback:
  - `comunicacao_destinatario_escopos` e `comunicacao_legado_snapshot` (doc 06 §1; **sem o par de colunas**, D-11);
  - colunas em `comunicacao_categorias` (`grupo`, `exige_consentimento`, `estado`, `fonte`, `prioridade`, `transporte`, `cota` jsonb) e seed de `fechamento_operacional_diario` (`estado = SIMULACAO`, `transporte = noop`);
  - nova versão de `comunicacao_resolver_destinatarios`: **um único comando** que lê a flag `selecao_por_escopo` (ausente/desligada → corpo atual idêntico);
  - RPC `comunicacao_ativar_selecao_por_escopo` (doc 07 §1.2), **criada mas não executada**;
  - lock consultivo compartilhado nas RPCs de agendamento do D-1, alterando **só** o acréscimo da chamada de lock (corpo restante idêntico, provado por diff textual no teste);
  - triggers de coerência e imutabilidade; RLS sem policy; privilégios mínimos.
- **Permissões (D-3):** `notificacoes.ver`/`notificacoes.gerenciar` em `permissoes.js` (gerente só na própria unidade); matriz do doc 06 §3.2; RPCs de escrita com `p_unidade_permitida`.
- **Backend `backend/src/modules/notificacoes/`:** `routes`, `controller`, `service`, `repository`, `escopos`, `legado` (vínculo de legado a unidade nova, só D-1), `pendencias` ("Nenhum destinatário configurado para o Dashboard iFood D-1"), `auditoria` (leitura sanitizada; `detalhes.unidade_id`).
- **Frontend:** Notificações → Destinatários, Categorias e horários, Histórico, Consentimentos (leitura), Auditoria. Atrás da flag `NOTIFICACOES_CENTRAL_ENABLED` (padrão desligado).

### B4 — OTP e consentimento (Etapa 3)

- **Migration `134_notificacoes_otp_consentimento`** + rollback:
  - tabelas: `comunicacao_convites`, `comunicacao_desafios_titular`, `comunicacao_consentimentos`, `comunicacao_termos`;
  - RPC atômica de consumo do desafio (uso único, tentativas, expiração, invalidação);
  - RPC de consentimento que exige desafio consumido + `termo_hash` vigente;
  - RPC de gestor que só aceita `REVOGADO`;
  - imutabilidade do livro-razão.
- **Backend:**
  - `notificacoes.otp.js` (puro: gerar com `crypto.randomInt`, HMAC, comparar), `notificacoes.titular.routes.js` (públicas, rate limit próprio, anti-enumeração com corpo e tempo constantes), `notificacoes.consentimento.js`;
  - transporte `noop` para OTP; em teste, o código só é observável por gancho de teste injetado, nunca por log.
- **Frontend `frontend/titular/`:** páginas mínimas e independentes do app (convite, código, consentimento, gestão/revogação), 390 px, acessíveis.
- **Termo:** versão "RASCUNHO — somente simulação", até a D-1 (jurídico).

### B5 — Integração dos módulos (Etapa 4) e cotas (D-9)

- **Migration `135_notificacoes_cotas_categoria`** + rollback:
  - RPC **nova** `comunicacao_reservar_envio_categoria` para categorias novas, com cotas próprias;
  - **`comunicacao_reservar_envio` (D-1) não é alterada**;
  - as cotas do D-1 continuam contadas como hoje, excluindo só as categorias novas.
- **Fechamento:**
  - `checklistOperacional.operacional.service.js`: depois de `REGISTRADO` (CONSOLIDADO/REVISADO), chama `notificacoes.enfileirarFechamento(fechamentoId)`;
  - chave `wa:fech:{fechamento_id}:{contato_empresa_id}:{inicial|correcao}`;
  - JIT cancela a versão superada;
  - o transporte da categoria é `noop`: status `SIMULATED`, provider = 0, **sem consumir cota real**;
  - nenhuma mensagem de fechamento sai pelo Baileys.
- `whatsapp.provider.js`: `sendTemplate` e `capabilities` (opcionais; o provider Baileys declara `templates: false, otp: false`); roteamento de transporte por categoria; `providers/noop.provider.js`.
- Os legados nunca recebem fechamento (CHECK + resolução + teste).

### B6 — Homologação (Etapa 5)

| Camada | O que roda |
|---|---|
| Unitários e integração | todas as suítes novas + as existentes de comunicação (75 arquivos), Checklist, iFood e usuários |
| **Regressão completa** | branch × `main` em condições equivalentes (mesmo comando, sequencial). Matriz exata: descobertos, executados, aprovados, falhas, pulados, timeout, preexistentes, introduzidas = **0** |
| **Prova do D-1** | doc 07 §1.1 (cenários: 1 unidade, 6 unidades, unidade antes/depois da ativação, desativada, de teste, reativada; 5 números compartilhados; 3 fusos) com a flag desligada e na ativação M3 simulada |
| **Ativação M3** (Postgres descartável) | atomicidade com falha injetada, duas sessões concorrentes (ativação × agendamento), idempotência, divergência plantada, universo inválido, snapshot imutável, desligar flag |
| **Permissões D-3** | uma linha da matriz por caso, nas três camadas (interface, API, banco/RPC) |
| **D-4** | nenhum E.164/código/token em logs, auditoria, respostas comuns (varredura); cifragem autenticada (adulteração do texto cifrado → falha); HMAC estável para dedupe; rotação por `chave_versao` |
| **D-9** | cotas do D-1 inalteradas; categoria nova não consome a cota do D-1; simulação não consome cota; limites de OTP independentes |
| **D-11** | teste estático do par de colunas; transferência com dados de notificação presentes (harness PG, cadeia real da `main`); `transferencia_unidades.sh` e `transferencia_checklist_metas.sh` verdes |
| **D-14** | convite: 32 bytes, hash, 72 h, uso único (concorrência real), conta existente sem senha, nenhuma senha em interface ou log, permissões por empresa e unidade |
| **D-15** | virada de dia em fusos diferentes (São Paulo, Porto Velho −4, Santarém); competência antes/depois do corte; fechamentos antigos intactos; agendador por unidade; equivalência Dashboard × fechamento na mesma unidade |
| **OTP** | CSPRNG, expiração 5 min, 5 tentativas, reenvio 60 s, invalidação, limites por telefone/IP/unidade/usuário, anti-enumeração, replay, consumo concorrente |
| **Supabase de TESTE** (com autorização já dada para o projeto de teste e pré-voo de identidade) | migrations 132–135 aplicadas **somente lá**; PostgREST: `anon`/`authenticated` negados em todas as tabelas novas; isolamento; consumo concorrente do OTP |
| **Navegador** | Configurações 2.0 inteira (teclado, 390 px, papéis), fluxo do titular, todos os testes de navegador existentes |
| **Simulação ponta a ponta** | convite → OTP (`noop`) → consentimento → escopo → fechamento enfileirado → `SIMULATED` |

### B7 — Entrega

- Docs: relatório de homologação no padrão do PR #54, atualização dos docs 01–11 com o que mudou na implementação.
- Commits locais. **Sem push e sem PR** até sua autorização.
- Limpar junções e o Postgres descartável.

## 4. Ambiente e flags (nada é criado em produção nesta execução)

| Item | Padrão | Quando ligar |
|---|---|---|
| `NOTIFICACOES_SEGREDO_MESTRE` (env) | ausente → Central desligada | criar só na implantação, com autorização |
| `NOTIFICACOES_CENTRAL_ENABLED` (env) | `false` | implantação, com autorização |
| `comunicacao_configuracoes.selecao_por_escopo` | ausente/desligada | **ativação M3: autorização específica** |
| `comunicacao_configuracoes.fuso_unidade_corte` | nula | definir a data com autorização (DEP-3) |
| Categoria `fechamento_operacional_diario` | `estado = SIMULACAO`, `transporte = noop` | só na Etapa 6 |

## 5. Dependências ainda não resolvidas

| # | Dependência | Bloqueia esta execução? | Precisa estar resolvida antes de |
|---|---|---|---|
| DEP-1 | **Alteração pendente do Financeiro na função de transferência** (`5233380`, reescreve a 120) | **não**: o desenho é invisível ao remapeamento. Pode gerar **conflito de merge** ou de teste se for publicada antes. Reavaliar no pré-voo | merge |
| DEP-2 | **E-mail de convite (D-14):** SMTP próprio no Supabase Auth (o padrão do Supabase é limitado e serve para teste), template pt-BR e `redirectTo` na lista de URLs permitidas | não (provedor `fake` nos testes) | primeiro convite real de usuário |
| DEP-3 | **Alcance da D-15:** usar o fuso da unidade também nos períodos do Dashboard 2.0 (necessário para "mesmos números" entre tela e fechamento). O Checklist ao vivo continua no fuso da plataforma (decisão anterior), então "hoje" do Checklist e do Dashboard podem diferir em 1 h nas unidades de Porto Velho. Também falta a data de corte | não (implementa com o recurso desligado) | definir o corte |
| DEP-4 | **Provedor oficial do WhatsApp (D-13)** + template de autenticação aprovado | não (OTP em `noop`) | primeiro OTP real / destinatário novo ativo |
| DEP-5 | **Textos jurídicos dos termos (D-1)** | não (texto rascunho só em simulação) | primeiro convite real de destinatário |
| DEP-6 | D-5, D-6, D-7, D-8, D-10, D-12 (doc 10, grupo B) | não | implantação / Etapa 6 |
| DEP-7 | **Autorizações:** aplicar 132–135 em produção, criar envs, publicar, deploy, ativar M3, ligar a Central | — | cada passo correspondente |
| DEP-8 | Promoção de unidade quebrada (42P10, Financeiro) | não (testes de promoção informativos) | — |
| DEP-9 | Verificação logada das abas novas do Dashboard 2.0 em produção (pendente da missão anterior) | não | — |

## 6. Critérios de aceite da execução

1. Todos os invariantes do §1 provados por teste automatizado (nenhum "passou isolado" contado como PASS).
2. Regressão: **0 falhas introduzidas** na matriz branch × `main`.
3. Prova do D-1 e garantias da M3 integralmente verdes.
4. Matriz D-3 verde nas três camadas.
5. D-4, D-9, D-11, D-14 e D-15 verdes conforme o §3 B6.
6. Supabase de **teste**: PostgREST e isolamento verdes; nada aplicado em produção.
7. Relatório final com a classificação GO PARA PR / GO CONDICIONADO / NO-GO, parando para a decisão de publicação.
