# Auditoria de prontidão — Central de Comunicação

Data: 24/09/2026. **Conclusão: ainda NÃO pronta para uma janela de produção.**

Existe uma corrida reproduzida entre a validação da operação e a gravação da confirmação da identidade. Os testes aprovados abaixo não eliminam esse bloqueio. Este documento registra a auditoria, as correções locais e os limites da evidência; não autoriza publicação.

## 1. Baseline e preservação do frontend

- Branch: `feat/comunicacao-central-conversas`.
- HEAD preservado: `6455bdc790414a3dbbd3b38565e74517c2024225`.
- Base remota examinada: `467c8d2e2472cca69aa1d328fc043630dc4ffa57`.
- Commits exclusivos: `0ba2508` (feature completa) e `6455bdc` (frontend aprovado); 97 arquivos no delta já commitado contra `origin/main`.
- A árvore estava limpa ao retornar à branch original. Os 22 arquivos do experimento eram cópia exata de seu frontend, sem commits exclusivos ou arquivos não rastreados. O experimento foi descartado e a branch temporária local removida, conforme solicitado.
- Nenhum histórico foi reescrito. Não houve commit, push, merge ou deploy nesta auditoria.
- `git diff 6455bdc -- frontend/` vazio. Nenhum redesenho, ajuste de UX ou alteração do Parser Food Delivery.

## 2. Rotas, autorização e contratos

Os **19 endpoints existem**. Prefixo HTTP completo: `/api/v1/administrativo`; os caminhos abaixo começam em `/comunicacao`.

Todas as rotas passam por `requireAuth`, `requirePainelAdministrativo`, MFA quando sua configuração já o exige e rate limit administrativo. Não houve mudança dessas configurações. Controllers em `administrativo.comunicacao.controller.js` usam `asyncHandler` e envelope `{ data }`, retirado por `frontend/src/painelAdmApi.js`.

Legenda das implementações:

- **CV**: `administrativo.comunicacao.conversas.js`.
- **CX**: `administrativo.comunicacao.conexao.js`.
- **R**: `comunicacao.roster.js`, view `comunicacao_roster_autorizado`.
- **CR**: `comunicacao.central.repo.js`, consultas ao inbox/outbox/cache de foto.
- **IR**: `comunicacao.inbox.repo.js`, RPCs da 096.
- **I**: `comunicacao.identidade.js`, tabelas `whatsapp_identidade`/`whatsapp_conexoes`.
- **P**: acesso ao painel. **G**: P e superadmin ou `comunicacao:gerenciar_conexao`.

| Endpoint | Autorização e service | Repository/RPC ou gateway | Contrato consumido e erros específicos |
|---|---|---|---|
| GET `/comunicacao/central/visao-geral` | P; CV.visaoGeral | R, CR, IR.resumoPorContato, I, resumo/organizações existentes | `cards`, `alertas`, `conversasRecentes`, `empresas`, `proximosEnvios`; erro de dados essenciais resulta em 5xx, não dados fictícios |
| GET `/comunicacao/central/automacoes` | P; CV.automacoes | CR.listarProximosEnvios, configuração, organizações, estado do gateway | `modo`, `ativa`, `whatsapp`, `dashboardIfoodD1`, `empresasHabilitadas:{total,itens}`, `proximosEnvios`; gateway desconhecido tem estado neutro |
| GET `/comunicacao/central/destinatarios` | P; CV.destinatarios | R, CR, IR e organizações | `itens`, `total`; nome, telefone mascarado, empresas/unidades, consentimento, verificação e opt-out; busca por nome |
| GET `/comunicacao/central/historico` | P; CV.historicoGeral | R, CR.listarSaidasRecentes, IR.listarMensagensDesde | `itens`, paginação e totais; filtros de empresa/unidade/status/origem/datas/operador; 400 em UUID, origem, status ou período inválido |
| GET `/comunicacao/central/diagnostico` | P; CV.diagnosticoTecnico | resumo existente, CR.listarUltimosErros, métricas do inbox | resumo + `inbox` + `ultimosErros`; ausência da lista de erros resulta em `[]` |
| GET `/comunicacao/central/atualizacoes` | P; CV.atualizacoes | CR.lerCursoresAtuais/contatosAlteradosDesde, IR.resumoPorContato, R | `cursor`, `mudou`, `contatosAlterados`, `naoLidas`, `gateway`, `modo`; 400 `CURSOR_INVALIDO`; IDs filtrados pelo roster |
| GET `/comunicacao/conversas` | P; CV.listarConversas | R, CR, IR.resumoPorContato | `itens`, `totais`, `filtro`, `cursor`; somente contatos reconhecidos pelo roster |
| GET `/comunicacao/conversas/:id` | P; CV.obterConversa | R, CR.listarSaidasDoContato, IR.listarMensagensDoContato, gates e auditoria | `contato`, `mensagens`, `janelaHoras`, `temMaisAntigas`, `envio:{podeEnviar,bloqueios,maxCaracteres}`, `cursor`; 404 para contato fora do roster; não marca lida implicitamente |
| POST `/comunicacao/conversas/:id/lida` | P; CV.marcarLida | R; `comunicacao_inbox_marcar_lida` | `{ok,lidaAte}`; data opcional `ate`; leitura monotônica por conexão/contato, sem recibo externo automático; 400/404 |
| POST `/comunicacao/conversas/:id/mensagens` | P + rate limit manual; CV.enviarMensagem | R, `comunicacao.manual.js`, outbox e RPCs de início/finalização com fencing, WhatsAppService | UUID `envioId`, texto até 4096, empresa/unidade opcionais; `{mensagemId,status,resultado,jaExistia,mensagem?}`; repetição não cria nova mensagem; 400/404/409 nos gates |
| GET `/comunicacao/conexao` | P; CX.estado | I; gateway status/perfil; permissão específica | seis estados, `identidade`, `conta:null|objeto`, `saude`, `tecnico`, `permissoes.gerenciar`, `operacao:null|objeto`; sem QR, perfil opcional |
| POST `/comunicacao/conexao/iniciar` | G + rate limit conexão; CX.iniciar | `whatsapp_operacao_iniciar`; gateway connect | `{operacaoId,expiraEm}`; 409 se operação ocupada, já conectado ou gateway indisponível |
| GET `/comunicacao/conexao/qr` | G; CX.qr | operação vigente + gateway qr/status/perfil | estado, `disponivel`, `svg`, datas/ordem/segundos, `identificada`, `conta`; `Cache-Control:no-store`; 409 para operação inválida/expirada |
| POST `/comunicacao/conexao/novo-qr` | G + rate limit; CX.novoQr | valida operação; gateway disconnect/connect | `{ok}`; 409 se já conectado/operação inválida/falha de conexão |
| POST `/comunicacao/conexao/confirmar` | G + rate limit; CX.confirmar | perfil vivo, grava identidade, auditoria, `whatsapp_operacao_encerrar` | estado completo; `operacaoId`, ambiente opcional e `utilizarComoAgente`; 400 ambiente; 409 desconectado/sem telefone vivo; **corrida pendente descrita abaixo** |
| POST `/comunicacao/conexao/cancelar` | G + rate limit; CX.cancelar | operação, gateway desconectar-conta/disconnect, identidade, encerramento RPC | estado completo; 409 operação inválida/falha; cancelamento antigo depois da confirmação agora é recusado |
| POST `/comunicacao/conexao/desconectar` | G + rate limit; CX.desconectar | trava RPC, gateway desconectar-conta, limpa identidade, auditoria | exige `confirmacaoExplicita:true`; estado completo; 400 sem confirmação, 409 ocupado/falha; preserva histórico |
| POST `/comunicacao/conexao/trocar` | G + rate limit; CX.trocar | trava RPC, logout/reset, limpa identidade, connect | exige confirmação; `{operacaoId,expiraEm}`; 400/409; falha depois do logout pode deixar desconectado, mensagem informa isso |
| PUT `/comunicacao/conexao/identidade` | G + rate limit; CX.definirIdentidade | leitura do estado + upsert de metadados + auditoria | `ambiente`, `agenteCrescer`; estado completo; 400 enum/tipo, 409 agente sem conta confirmada; não muda modo operacional |

401/403 são transversais à autenticação/permissão; 429 aos limites. `ApiError` propaga status/mensagem. O frontend trata rejeições, preserva navegação e exibe erro/repetição; não fornece substitutos funcionais para rotas ausentes. Falhas de operações não são apresentadas como sucesso.

Cobertura por grupo: `central-rotas-http.test.js`, `central-conversas.test.js`, `central-visao-historico.test.js`, `central-envio-manual.test.js`; conexão em `central-conexao-http.test.js` e `central-conexao.test.js`; persistência/isolamento em `central-postgres-real.test.js`; inbound em `central-inbox.test.js` e `central-inbound-rota.test.js`.

## 3. Frontend espera × backend entrega

- Os nomes de campos e os envelopes dos 19 métodos foram confrontados com `painelAdmApi.js`, controladores e modelos da Central.
- Fotos, descrição, tipo de conta, datas e conta conectada são opcionais. Sem foto há iniciais; sem identidade confirmada não aparece agente confirmado. `DESCONHECIDO`, `null` e arrays vazios são aceitos.
- `atividade`, `cards.alertasHoje` e detalhamento opcional de unidades não são requisitos do endpoint de Visão Geral. O frontend deriva atividade/empresas dos dados existentes, sem mock em produção.
- Estados da conexão: `CONNECTED`, `DISCONNECTED`, `CONNECTING`, `WAITING_QR`, `RECONNECTING`, `AUTH_ERROR`. Identidade: `SEM_CONTA`, `PENDENTE_CONFIRMACAO`, `CONFIRMADA`. O frontend distingue sessão conectada de identidade confirmada.
- Origem/status das mensagens são projetados pelo backend; envio duplicado pode não trazer `mensagem`, e esse contrato já é tratado pelo cliente.
- Datas usam ISO; o painel calcula o dia brasileiro, enquanto o agendamento considera timezone/janelas da organização. Não são a mesma regra.
- Acrescentado teste que passa **respostas produzidas pelos services reais**, com banco fake somente no teste, aos renderizadores aprovados de Visão Geral, Automações, Destinatários, Histórico e Diagnóstico. Arrays vazios e opcionais ausentes renderizam sem `undefined`/`NaN`.
- Sem 096/097, a feature completa não tem suporte funcional: consultas essenciais a view/inbox/RPC falham. O fallback visual de identidade não substitui essas migrations. Publicação isolada do frontend continua descartada.

## 4. Correções locais realizadas

1. `IdentidadeNaoConfirmadaError` agora declara `preEnvio:true`: recusa antes do provider não é classificada como entrega incerta.
2. Card de enviadas exclui `FAILED` e demais estados não enviados; total de registros do dia permanece separado.
3. QR/renovação exigem operação não expirada. Cancelamento atrasado não desconecta uma conta já confirmada quando a trava foi encerrada.
4. Cache de perfil passa a considerar organização, instância, telefone e início da conexão; é limpo quando desconectado.
5. Confirmação exige telefone obtido do perfil vivo; não reaproveita telefone antigo do heartbeat quando a consulta não identifica a conta.
6. Cursor rejeita datas não interpretáveis. Primeira mensagem de uma direção antes vazia entra na atualização; lote saturado invalida todo o roster autorizado, em vez de avançar omitindo conversas.
7. Gateway não interpreta JID `@lid` numérico como telefone E.164 da conta.
8. Validadores 096/097 passam a encerrar com erro quando houver qualquer verificação negativa; não apenas imprimir FAIL e retornar sucesso.
9. Integração da Central falha explicitamente no preparo quando faltam pré-requisitos e usa contato de teste variável, com erro de insert verificado. Isso evita cascata de fixtures nulas e colisão com execução interrompida anterior.

Todas essas correções têm regressões executadas. Nenhum mock foi adicionado ao código de produção.

## 5. Migrations 096/097

**Produção recebeu apenas consultas ao catálogo com `transaction_read_only=on`.** 096/097 continuam ausentes. PostgreSQL 17.6; dependências de colunas de contatos/vínculos/perfis/organizações/unidades/conexão, `auth.users` e `set_updated_at()` verificadas.

- 096: três colunas nullable de foto, view `security_invoker`, duas tabelas e **quatro** funções (o cabeçalho antigo diz três): registrar, resumo, marcar lida e purgar. Dependências estruturais incluem 060/082; integra-se ao inbound técnico da 090 sem alterar seu livro-razão.
- 097: duas tabelas, duas funções e trigger de atualização; FKs para organizações, perfis operacionais e auth.users. Não cria permissões para usuários existentes nem identidade confirmada.
- Aplique na ordem versionada **096 → 097**, após confirmar as migrations anteriores da main. A 097 não referencia diretamente a 096, mas a aplicação precisa das duas e dos contratos anteriores de fila/recibos, inclusive 095.
- RLS habilitada, sem policies de acesso de clientes; revokes para public/anon/authenticated. View e RPCs têm concessões explícitas para service_role; funções são invoker com search_path fixado. Acesso às tabelas pelo service_role depende dos defaults do executor: verificados no catálogo de produção para `postgres`/`supabase_admin`, e exercitados em teste.
- Índices/constraints cobrem idempotência por conexão/providerMessageId, leitura por contato/data, retenção, PK da identidade e consistência da trava/hash. Trigger usa `set_updated_at()` existente.
- Sem DML que altere NORMAL/DISABLED, habilitações ou outbox. Purga atua no inbox novo; não nos registros técnicos nem nas saídas.
- Rollback **097 → 096** remove somente objetos da feature, mas perde identidades/permissões novas e conteúdo do inbox. Exige backup e coordenação com o código; não executar enquanto o código novo ainda depende desses objetos.
- Verificações reais de aplicação, reaplicação, rollback e catálogo feitas somente no banco de teste. Resultados finais complementados na seção de testes.
- Idempotência de `IF NOT EXISTS` não corrige schema previamente divergente: comparar catálogo continua obrigatório.

## 6. Gate de identidade e fila

- Avaliado no manual, teste controlado, política do worker e no WhatsAppService imediatamente antes de cada chamada ao provider. Factories de produção injetam o gate; não usam `semGateIdentidade:true`.
- Exige conexão com heartbeat recente e hash igual ao telefone confirmado. Ausência de organização/tabela/linha, erro de leitura, retorno não booleano ou identidade diferente bloqueiam envio.
- Leitura do painel, histórico, recebimento autorizado, monitoramento e agendamento continuam funcionando.
- Bloqueio na política é transitório: `PROCESSING → SCHEDULED`, calcula próximo instante permitido com janela/timezone/pausa/jitter, **sem tentativa**. Mensagens que já estavam SCHEDULED passam pela mesma avaliação.
- Após confirmação, o próximo processamento reavalia todos os gates; não há flush indiscriminado da fila. Teste com PostgreSQL real comprovou zero chamadas e zero tentativas durante pendência, depois uma única chamada ao provider falso.
- Expiração/TTL cancela antes de envio; reforço/aviso tardio não são empurrados além do cutoff. Janela comercial e identidade são condições independentes.
- **Ressalva:** se a identidade mudar depois da reserva atômica, o último gate bloqueia o provider, mas a tentativa já foi reservada e contabilizada. `preEnvio:true` permite tratamento retryável; não significa que a reserva foi desfeita. Portanto, “nunca consome tentativa” só é verdadeiro para o bloqueio anterior à reserva.
- Fencing e idempotência protegem a fila; ambiguidade externa continua `DELIVERY_UNKNOWN`, sem retry cego. Não há garantia abstrata de exactly-once na rede.

## 7. Gateway e permissões

Revisados os deltas em sessão, inbound, QR e rotas. Reuso da sessão Baileys existente, sem segunda sessão/credencial no frontend. Internos relevantes: `/whatsapp/status`, `/connect`, `/disconnect`, `/reset`, `/qr`, `/perfil`, `/desconectar-conta`, `/perfil-foto`, `/messages` e recibos. Autenticação HMAC inclui método/path/body/timestamp/nonce; rotas protegidas e testes de rejeição executados.

QR fica transitório em memória; resposta à UI contém SVG, não a string crua; heartbeat/auditoria não transportam o segredo. Logout/reset e troca preservam histórico de negócio. Perfil opcional indisponível resulta em campos neutros; confirmação exige identidade viva após a correção.

| Usuário | Ler Central/conversas | Envio manual | QR/confirmar/conectar/trocar/desconectar |
|---|---|---|---|
| Comum sem acesso ao painel | Não | Não | Não |
| Acesso ao painel, sem permissão de conexão | Sim | Sim, sujeito aos gates e roster | Não; Conexão somente leitura |
| Painel + `comunicacao:gerenciar_conexao` | Sim | Sujeito aos mesmos gates | Sim, mediante operação e confirmações exigidas |
| Superadmin autenticado | Sim | Sujeito aos gates | Bypass da permissão específica |

“Somente leitura” é o estado da **aba Conexão**, não um papel global que proíba envio manual. Permissão específica isolada não concede entrada no painel. Nenhum usuário foi habilitado ou promovido. `ambiente:TESTE` é metadado visual, **não sandbox de envio**.

## 8. Testes e regressões

| Grupo | Evidência final |
|---|---|
| Backend comunicação/Central/gateway backend/worker | 949 testes aprovados na execução serial abrangente; integração externa fica protegida pelo preflight e é executada separadamente abaixo |
| Contratos services → renderizadores aprovados | 17/17 no arquivo de Visão Geral/Histórico após acrescentar o contrato vazio; inclui casos já presentes na suíte abrangente, não somar como testes exclusivos |
| Frontend Central e Painel Administrativo relacionados | 441/441 aprovados |
| Gateway completo | 928/928 aprovados após a correção do LID |
| Central contra PostgreSQL de teste | 32/32 aprovados, com provider/gateway falsos e SQL/Supabase reais |
| Pipeline real de adiamento, incluindo identidade | 10/10 aprovados |
| Integração real de TTL/unknown/reconciliação/capacidade | 57/57 aprovados na rodada integrada; sem mensagens externas |
| Validadores SQL | 096: 53 verificações; 097: 54 verificações; todos PASS |
| Rollback e idempotência | Catálogo após 097→096 rollback idêntico ao baseline; 096/097 reaplicadas duas vezes sem erro; seeds ZZVAL removidas |
| Concorrência da trava SQL | Oito sessões simultâneas: uma adquiriu a operação e sete foram recusadas; trava de QA removida. Isso testa aquisição, não elimina a corrida de confirmação |
| Sintaxe | 81 arquivos JavaScript diferentes da main verificados com `node --check` |
| Imports/CSS frontend | imports da Central/ícones sem erro; quatro CSS analisados, sem seletores duplicados; warning preexistente de variável `silencioso` não usada e aviso Node de tipo de módulo |
| Diff | `git diff --check` aprovado; frontend e Parser sem alteração nesta auditoria |

Falhas intermediárias foram mantidas nos logs: execução backend concorrente teve flutuação de temporização em shutdown do worker (48 ms frente ao mínimo de 60 ms); repetição serial passou sem alterar o teste. Integração inicial da Central teve fixtures não preparadas durante a transição do catálogo; o preparo passou a explicar a falha. Uma execução seguinte detectou colisão de telefone fixo de fixture, corrigida sem excluir a asserção funcional. A última execução integral da Central passou.

Parser Food Delivery: não alterado no delta da feature nem nesta auditoria. Sua falha conhecida continua fora de escopo; não foi silenciada. Não foi feito smoke em produção, login real ou conexão real nesta etapa.

## 9. Riscos restantes e bloqueio de produção

> **Atualização:** os itens sobre confirmação atômica, limite de 500 mensagens por direção, "Enviadas hoje" por `created_at` e fencing das ações do gateway foram resolvidos nas migrations 098/099 (ver seção 12). O restante desta seção continua válido como registro de riscos.

**Bloqueio reproduzido — confirmação de operação substituída.** Em `CX.confirmar`, `verificarOperacao` roda antes de status/perfil do gateway; `salvarIdentidade` faz upsert sem condicionar a gravação ao `operacao_id` validado. Em uma reprodução local, o retorno do perfil foi intercalado com a substituição da operação por uma nova `TROCAR`. A confirmação antiga gravou `CONFIRMADA`, preservando o ID da nova operação. `whatsapp_operacao_encerrar` protege o encerramento, mas não protege a gravação anterior. Nenhuma rede ou conta real foi usada na prova.

É necessário condicionar atomicamente a confirmação à operação vigente e revisar cancelamento/troca durante expiração/retomada, incluindo as ações externas no gateway. Uma nova leitura simples antes do upsert não elimina a corrida. O comentário antigo de que duas operações são impossíveis não constitui prova dessa propriedade. Não foi aplicada uma solução parcial em memória que só funcionaria com uma réplica.

Outros limites concretos identificados:

- Consultas de conversa usam limite de 500 por direção em ordem crescente: volume acima disso pode omitir as mensagens mais novas. Histórico e cards também trabalham com limites de consulta; não prometer totais ilimitados.
- O card diário seleciona saídas por `created_at`; mensagem criada ontem e enviada hoje não entra nesse conjunto. A correção de FAILED resolve status, não muda essa definição temporal.
- Sobreposição do cursor é de cinco segundos, não proteção para transações arbitrariamente longas. Cursor atual é global e IDs retornados são filtrados pelo roster administrativo cross-tenant.
- Identidade é consultada no banco; uma troca física entre heartbeat/check e envio demanda coordenação/fencing com o gateway para uma garantia mais forte. A confirmação viva corrigida reduz um problema, mas não torna todo o protocolo atômico.
- Consultas opcionais de perfil no gateway são sequenciais e têm timeout individual; lentidão combinada pode exceder o timeout da chamada do backend. Estados neutros evitam crash, mas não eliminam latência.
- A regra exata de tentativa na recusa posterior à reserva precisa ser aceita ou ajustada antes de afirmar “zero tentativas em qualquer bloqueio”.

## 10. Sequência recomendada para uma futura janela

1. Resolver a corrida de operação com persistência condicional/atômica e proteção dos efeitos externos; testar concorrência, expiração e retomada em banco/gateway de teste.
2. Fechar os limites de paginação/métrica e a semântica da tentativa tardia; repetir regressões e contrato integrado.
3. Versionar e revisar o delta completo. Confirmar versões compatíveis de API, frontend, worker e gateway e o comportamento de auto-deploy antes de qualquer push que publique.
4. Com autorização específica para a janela, fazer backup e definir reversão. Coordenar workers/ações de conexão para impedir execução com versões divergentes; não alterar modos/habilitações implicitamente.
5. Aplicar 096 e depois 097; aguardar catálogo PostgREST e validar permissões/objetos antes de colocar código dependente em serviço.
6. Publicar componentes compatíveis de forma coordenada. Manter identidade não confirmada até verificação e autorização humana separadas; não tratar o rótulo TESTE como proteção contra envio real.
7. Smoke read-only de login/painel/abas, desktop/mobile, console/rede e estado pendente; confirmar preservação de modo/habilitações/destinatários e comportamento SCHEDULED.
8. Só numa etapa explicitamente autorizada verificar/confirmar conta e avaliar a fila elegível. Nenhuma dessas ações foi executada nesta auditoria.

As correções permanecem locais e não commitadas. Produção, conexão real, mensagens, modos e habilitações permaneceram intocados.

## 11. Escopo do fechamento técnico

A lista completa de arquivos alterados depois de `6455bdc` (backend, gateway, frontend, migrations 098/099, validadores SQL e documentação) é a do commit de fechamento técnico (`git show --stat`). Esta seção não replica o inventário para não divergir do histórico do Git. Scripts temporários de QA ficam fora do repositório. O estado final de fencing e reconciliação está na seção 12.

## 12. Migrations 098/099: fencing e reconciliação de efeitos externos (atualização posterior)

Esta seção substitui as afirmações desatualizadas das seções 9–11 sobre confirmação atômica, paginação, "Enviadas hoje" e fencing.

- **098** (confirmação atômica, token de efeito, paginação) e **099** (reconciliação) são migrations novas sobre a 097; nenhuma altera outbox, claim, modo ou habilitações. Ordem: 096 → 097 → 098 → 099. Rollback na ordem inversa; ambos recusam rodar com efeito externo pendente.
- **Estados do efeito:** PENDENTE (token gerado, nunca consumido) → EXECUTANDO (gateway consumiu, ação em curso) → CONCLUIDO (token liberado) | INCERTO (resultado não confirmado).
- **Falha determinística × incerteza real (gateway `operacaoConexao.js`):** guardas do gateway anteriores a qualquer efeito (`SEM_LEASE`, `JA_CONECTADO`, `NAO_CONECTADO`) chamam `FALHA_DETERMINISTICA` (EXECUTANDO → livre). Qualquer outro erro após o CONSUMIR (timeout, queda, resposta perdida) marca INCERTO. Se o gateway nem consegue registrar a falha determinística, degrada para INCERTO (fail-safe).
- **Reconciliação oficial:** `POST /administrativo/comunicacao/conexao/reconciliar` ("Rever estado da conexão"). Exige `comunicacao:gerenciar_conexao` ou superadmin. O backend consulta o estado vivo do gateway (status e `authSessionId`) e chama a RPC `whatsapp_operacao_reconciliar`; **a decisão é do banco**, sob `FOR UPDATE`, comparando com o snapshot da sessão (`efeito_auth_session_id`) gravado no PREPARAR. Não existe parâmetro para forçar sucesso.
- **Decisões:** janela de estabilização de 30 s desde a última transição (logout em voo) → `AINDA_INCERTO`. Gateway indisponível, sem perfil ou contraditório → `AINDA_INCERTO`. DESCONECTAR: gateway não conectado ou sessão diferente → CONCLUIDO (limpa a identidade e fecha a operação); mesma sessão ativa com heartbeat fresco → ABORTADO (identidade preservada). RESET: sessão diferente → CONCLUIDO; mesma sessão ativa → ABORTADO; sem snapshot → INCERTO. CONECTAR: pareamento/conexão ativos → CONCLUIDO; gateway desconectado → ABORTADO. ENCERRAR: gateway desconectado → CONCLUIDO; ainda ativo → ABORTADO. PENDENTE antigo → ABORTADO (token revogado; um CONSUMIR tardio é recusado). EXECUTANDO parado é promovido a INCERTO.
- **Idempotência/concorrência:** repetir a reconciliação devolve `JA_RESOLVIDO` (sem nova auditoria); duas simultâneas produzem uma decisão real e uma `JA_RESOLVIDO`. Enquanto o efeito estiver realmente INCERTO, nenhuma operação nova (iniciar/cancelar/confirmar) assume.
- **Auditoria:** ação `WHATSAPP_CONEXAO_RECONCILIADA` com operação, ação, decisão, motivo e estado do gateway (sem token, QR ou telefone).
- **Observabilidade (`GET /conexao`, campo `operacao`):** `efeitoEstado`, `efeitoAcao`, `reconciliacaoNecessaria`, `incertoDesde`, `ultimaVerificacaoEm`, `verificacoes`, `ultimoResultado`, `podeReconciliar` — sem token. O frontend aprovado não foi alterado; só foi adicionada a função `conexaoReconciliar` em `painelAdmApi.js`.
- **Automação:** não há reconciliação automática (uma leitura GET não deve ter efeito colateral, e polling agressivo foi evitado). A verificação é disparada por um operador autorizado.
- **Limites conhecidos:** a decisão depende do estado informado pelo gateway; ABORTADO por "sessão original ativa" após a janela de 30 s assume que um logout em voo já teria se manifestado. Falha do gateway depois do efeito externo continua sem atomicidade distribuída — por isso o estado INCERTO existe.

- **Interface (aba Conexão):** com `reconciliacao.reconciliacaoNecessaria` (campo novo em `GET /conexao`, sem id de operação nem token, visível a qualquer usuário do painel) aparece um bloco de atenção com operação, "sem confirmação desde", último resultado e última verificação. Quem tem `permissoes.gerenciar` vê "Verificar estado da conexão" (um clique = uma requisição `POST /conexao/reconciliar`, sem corpo); quem só lê vê a orientação para procurar um administrador autorizado. Estados: normal, verificando, CONCLUIDO, ABORTADO, AINDA_INCERTO (neutro, "poderá verificar novamente mais tarde"), JA_RESOLVIDO e erro. Não há polling de reconciliação, nem controle para marcar sucesso, forçar aborto, escolher resultado ou editar token/operação.
- **Script de concorrência (`database/validacao/098/test-concorrencia.sh`):** barreira determinística (o holder comprovadamente segura o lock e cada contendora comprovadamente espera em `wait_event_type='Lock'`; se a barreira não se forma o resultado é INFRA/exit 3, nunca um FAIL funcional mascarado). Toda falha imprime cenário, rodada, operações A/B, esperado, obtido, SQL, horários local/banco e o estado da linha; exit 1 = violação funcional, 3 = inconclusivo. Trava consultiva impede duas execuções simultâneas (elas mutam a mesma organização de seed que `test098/test099`); **não rode `test098.sql`/`test099.sql` enquanto o script estiver rodando**. O banco de teste tem `statement_timeout=2min`: sessões longas usam vários `pg_sleep(60)`.
