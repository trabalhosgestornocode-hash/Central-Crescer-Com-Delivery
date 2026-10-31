# 12 — Relatório de implementação e homologação (Etapas 1–5)

Data: 30/10/2026. Branch local `feat/configuracoes-2-central-notificacoes` (worktree `crescer-config2-impl`), base `origin/main` `9da8210`.
**Nada foi publicado:** sem push, PR, merge, deploy, migration em produção, variável de produção, envio real (WhatsApp, OTP ou
e-mail) ou ativação da M3. Nenhuma alteração no monitor atual do D-1 nem na função de transferência de unidades.

## 1. Entregas

| Bloco | O que foi feito | Onde |
|---|---|---|
| A — Segurança | Cifra autenticada (AES-256-GCM, chave por HKDF) + HMAC para telefone/e-mail/IP/código; números mascarados; logs sanitizados; permissões `notificacoes.ver/gerenciar`; recorte D-3 no backend **e** no banco; privilégios mínimos (anon/authenticated sem nada nas tabelas e funções novas, inclusive gatilhos) | `shared/cripto.js`, `modules/notificacoes/*`, migrations 132–135 |
| B — Configurações 2.0 | 7 categorias; navegação lateral / lista → detalhe no celular; validação por campo; estado de salvamento; diálogo acessível; dados da unidade, fuso e horário; metas e Tabelas Comerciais (inalteradas); usuários com convite por e-mail (sem senha definida pelo admin); integrações; senha própria, 2FA; privacidade; tema e dados locais. Nenhum recurso anterior removido | `frontend/src/configuracoes.js`, `configuracoes.css` |
| C — Central | Destinatários (LEGACY_ACTIVE preservado), convites (link exibido uma vez), suspensão, preferências que só restringem, vínculo de legado (só D-1, só após a M3), pedido de revogação, histórico, consentimentos, auditoria; função M3 implementada, **travada** (409) e **não executada** fora do PG descartável | `configuracoesNotificacoes.js`, `notificacoes.service.js`, `notificacoes.m3.js`, migration 133 |
| D — OTP + consentimento | Em **simulação** (caixa em memória; só com `NOTIFICACOES_AMBIENTE_ISOLADO=true` e fora de produção). Páginas públicas do titular: convite → código → consentimento (nada pré-marcado, termo versionado RASCUNHO) e gestão (anti-enumeração, revogação imediata). Baileys **não** ligado ao OTP | `notificacoes.titular.service.js`, `frontend/notificacoes/*`, migration 134 |
| E — Integração | D-1: resolvedor 104 intacto, uma linha alterada no agendador, cotas intactas. Fechamento diário: aviso de fechamento **simulado** (`operacional_mensagens_simuladas`, nunca a fila do D-1). Mesmos números em tela, PDF, Excel e prévia | migration 133/135, `notificacoes.fechamento.js` |
| F — Fuso | `resolverFuso` único com data de corte (desligada por padrão) para Dashboard 2.0 **e** fechamento; competência por unidade no agendador; Ficha 360° e telas do Dashboard exibem no fuso informado pelo servidor; Checklist ao vivo inalterado | `checklistOperacional.fuso.js`, `checklistOperacionalFuso.js` |

## 2. Testes e evidências

| Camada | Resultado | Evidência |
|---|---|---|
| PostgreSQL real descartável (cadeia REAL da main até a 131 + 132–135, dono não-superusuário, privilégios do Supabase) | **74/74 OK** | `evidencias/pg-132-135-descartavel.log` |
| Backend — suítes novas (segurança, Central, titular, fuso/fechamento, convites/M3) | 77/77 | `backend/test/notificacoes-*.test.js`, `configuracoes2-*.test.js` |
| Frontend — unidade | 1647 testes, 1622 ok, **0 falha**, 25 pulados (navegador sem Playwright, igual à main) | `frontend/test/configuracoes2.test.js` (21 novos) |
| Navegador real (Chrome) — Configurações 2.0, Central, titular, 390 px, tema escuro | **8/8** | `evidencias/navegador-configuracoes2.txt`, `evidencias/telas/*.png` |
| Navegador real — todas as suítes do projeto | 125/126; a falha (`parserFoodDelivery` "dia único") **também falha na main `9da8210`** (verificado num worktree da main) | — |
| Backend — regressão completa × main | ver §3 | matriz em §3 |

### Evidências do D-1 (sem alteração)
- Seleção desligada: **mesmas** mensagens (destinatários, chaves, conteúdo, horários, metadados, status) na main e na branch; motivo OPT_OUT idêntico.
- Durante a ativação M3 (duas sessões concorrentes) e depois dela: D-1 idêntico ao da main nas unidades existentes.
- Rollback 135→132: agendamento idêntico ao da main; nenhuma tabela nova sobra; reaplicação idempotente.
- `comunicacao_reservar_envio` (cota do D-1) intacta; categorias novas com cota própria, só lida pela simulação.

### Evidências de segurança
- anon/authenticated sem privilégio nas 7 tabelas novas e sem EXECUTE em nenhuma função nova (**achado e corrigido**: gatilhos herdavam EXECUTE pelos privilégios padrão do Supabase).
- Snapshot e livro-razão imutáveis (privilégio **e** gatilho, mesmo para o dono).
- CONCEDIDO sem prova (OTP + termo + evidência) recusado pelo banco; nenhum CONCEDIDO fabricado para legados.
- Gestor/Painel não reativa categoria revogada pelo titular; revogação numa empresa não afeta a outra.
- OTP: reenvio 60 s, 5 tentativas, bloqueio, uso único sob concorrência, replay recusado; o código nunca volta pela API e só o HMAC vai ao banco.
- Anti-enumeração na gestão: mesma resposta e tempo mínimo; **achado e corrigido** um vazamento (INCORRETO × INVALIDO) no meu próprio código — unificado em `NAO_CONFERE`.
- Convite de usuário: uso único sob concorrência, e-mail divergente recusado, validade ≤ 72 h, token só como hash.

### Evidências da M3 (simulada no PG descartável)
- Atômica, idempotente (`JA_ATIVADA`), recusa outra migração, recusa unidade inativa no universo sem gravar nada.
- Divergência plantada → `ATIVACAO_EQUIVALENCIA_FALHOU` com rollback total.
- Snapshot = legados com D-1 × unidades do universo (14 linhas no cenário); unidade inativa e de teste fora.
- D-16: unidade nova não herda legados; vínculo explícito só D-1, auditado; gerente de outra unidade não vincula.

### Transferência de unidades (D-11)
Função idêntica à da main (não modificada); transferência conclui com escopos, snapshot e livro-razão presentes e intocados;
a autorização não atravessa empresas.

## 3. Regressão completa × main

Mesmo ambiente fictício (`SUPABASE_URL=http://127.0.0.1:9`, sem `DATABASE_URL`), `node --test test/*.test.js`, TAP comparado teste a teste.

| | main `9da8210` | branch (2ª execução, final) |
|---|---|---|
| Backend — testes | 5681 | 5760 (+79) |
| Backend — ok | 5642 | 5720 |
| Backend — falhas | 14 | 15 |
| Backend — pulados | 25 | 25 |
| Frontend — testes / falhas | 1618 / 0 | 1647 / 0 |

- **Falhas em ambas (14):** as conhecidas da main (11 da Central de Comunicação — datas fixas vencidas —, performance-calc e
  sessão-perfil ×2). Nenhuma delas é desta frente.
- **Falha só na branch (1):** `dashboard-executivo-metas-dinamicas.test.js` com o processo filho encerrado por violação de acesso
  nativa (`exitCode 3221225477` = `0xC0000005`), não por asserção. **Intermitente e pré-existente:** rodando os mesmos 3 arquivos
  5 vezes num worktree da main `9da8210`, o mesmo encerramento ocorreu em 2 das 5 execuções. Módulos de Dashboard iFood e
  Bonificação não foram tocados. Na 1ª execução da branch, o mesmo sintoma apareceu em outros dois arquivos
  (`bonificacao-importacao-diaria`, `dashboard-executivo-periodo-misto`), que passaram na 2ª.
- **Falhas só na main:** nenhuma.
- **1ª execução da branch:** 21 falhas = 14 conhecidas + 2 encerramentos nativos (acima) + 5 defeitos reais desta frente
  (M3 403/rede, matriz do tenant, catálogo de papéis) — corrigidos no commit `f9f4959` (ver §4/§5).

## 4. Correções feitas durante a homologação (defeitos introduzidos por esta frente)

1. Gatilhos com EXECUTE para anon/authenticated (privilégio padrão) → revogados explicitamente; teste cobre todas as funções novas.
2. Vazamento de enumeração na verificação da gestão → resposta única `NAO_CONFERE`.
3. Trava da M3 respondia 403 (significa "sem autorização" no Painel) → 409 `M3_BLOQUEADA_NO_AMBIENTE`.
4. Controller da M3 ignorava a seam de teste do Painel (`app.locals.adminDeps`) e saía para a rede na matriz de autorização → corrigido.
5. Router `/notificacoes` faltava na matriz de isolamento do tenant → incluído (as rotas novas passam pela matriz).
6. Barra de salvar fixa sobrepunha o conteúdo de outra seção → barra estática no fim de cada formulário.

## 5. Mudanças deliberadas em contratos existentes (aprovadas, não flexibilização)

- **Catálogo de papéis (D-3):** `unit_manager` ganhou `notificacoes.ver` e `notificacoes.gerenciar`; `finance` ganhou `notificacoes.ver`.
  O teste `perfil-exibicao-permissoes` continua exigindo igualdade EXATA, com os acréscimos declarados em `ACRESCIMOS`.
- **Allowlists de arquitetura** (`comunicacao-arquitetura-agendamento`, `ifood-migration-103`): incluídos os arquivos 132–135.
- **Conceder acesso (D-14):** a tela não pede mais senha; a API ignora `senha`. Conta existente = vínculo como antes; conta nova = convite.

## 6. Limitações conhecidas

- Contas **novas** de usuário dependem do envio de e-mail (DEP-2); até lá o convite fica registrado e a tela avisa que o envio está desativado.
- O redirect do e-mail do Supabase com `#t=` precisa ser confirmado com e-mail real (DEP-2).
- Homologação no banco de teste remoto **não** feita: o pré-voo mostrou que ele não tem 101–105, 127 e 131 (DEP-10). A homologação foi feita no PostgreSQL local descartável com a cadeia real da main.
- O horário de funcionamento é informativo nesta versão.
- A palavra-chave SAIR depende do inbound do WhatsApp, hoje parado.

## 7. Itens de operação

- Junctions `node_modules` do worktree e o cluster PostgreSQL descartável: removidos/parado ao final.
- Durante a verificação da falha do Parser na main, um `git worktree prune` limpou a metadata de UM worktree cuja pasta já não existia
  (`crescer-wt-100`); as demais entradas órfãs ficaram como estavam (sem permissão). Os dois worktrees temporários da main usados para
  comparar (`wt-main-pfd`, `wt-main-crash`) foram removidos; a metadata deles em `.git/worktrees` não pôde ser apagada (permissão), como as
  órfãs antigas. Nenhuma branch, commit ou worktree ativo foi afetado.

## 8. Revisão final do PR #55 (30/10/2026, commit `b5ca1f2`)

**Achados e correções desta revisão:**

| # | Achado | Severidade | Situação |
|---|---|---|---|
| R1 | Cifra autenticada aceitava tag GCM truncada (4 bytes) — Node só fixa o tamanho com `authTagLength` | Baixa (exige escrita no banco para explorar) | **Corrigido** + teste |
| R2 | Faltava teste HTTP das rotas públicas (só POST, 429 por IP, sem cache/referrer) e do D-3 por papel | Lacuna de teste | **Coberto** (`notificacoes-http-negativos.test.js`, 9 testes; recusas não tocam dados e são auditadas) |
| R3 | Prova do D-1 não cobria idempotência ao reagendar nem a definição da fila | Lacuna de teste | **Coberto** no PostgreSQL (77/77) |
| R4 | Perfis Financeiro/Consulta/Operação não testados no navegador | Lacuna de teste | **Coberto** com o catálogo real de permissões |
| R5 | Piso de 700 ms na gestão do titular: se o caminho real passar disso em produção, a existência do número pode vazar pelo tempo | Baixa/média | **Risco residual** — medir na homologação e subir o piso se preciso |
| R6 | Link de convite montado com `req.protocol`/`Host` | Baixa (`trust proxy` em produção; redirect do e-mail limitado pela lista do Supabase) | Aceito |
| R7 | Números de quem CONSENTE ficam em `comunicacao_contatos_empresa.telefone_e164` (coluna existente, em claro, como os legados) | Informativo | Modelo atual do D-1; cifra cobre convites e desafios |
| R8 | 503 "indisponível" das rotas públicas gera stack no log | Ruído (sem dado) | Aceito |
| R9 | Admin da empresa perde a criação de conta com senha (D-14) até o SMTP; SuperAdmin continua criando | Operacional | Decisão de implantação (doc 14 §1) |

**Verificado e sem achado:** sem `SECURITY DEFINER`; 25 funções com `search_path` fixo; RLS nas 7 tabelas; logs só com ids/contagens;
tokens nunca na URL; páginas públicas sem script inline e com `textContent`/escape; preview do Vercel protegido por login;
nenhum preview do Render no PR; aceite de convite funciona para conta sem `perfis`; app inicia sem o segredo; nenhum conflito novo
com as branches do Financeiro (mesmas contagens que a main) e nenhuma colisão de número de migration.

**Regressão final × main (`9da8210`):** backend 5777 / 5738 ok / **14 falhas = as mesmas 14 da main, 0 só na branch** / 25 pulados;
frontend 1648 / 0 falhas; navegador 126/127 (a falha `parserFoodDelivery` "dia único" ocorre igual na main); PostgreSQL descartável 77/77.

**Não executado (não classificar como PASS):** homologação no Supabase de teste (bloqueada — doc 14 §4); validação via PostgREST real;
e-mail real do convite de usuário; medição de latência da gestão do titular; testes em celular físico (feitos em viewport de 390 px).

## 9. Consolidação (30/10/2026, commit `9269af3`)

| # | Item | Situação |
|---|---|---|
| C1 | Origem dos links de convite vinha de `Host`/protocolo da requisição | **Corrigido**: só `APP_URL_PUBLICA` (https, só origem); produção sem ela = 503 antes de gravar |
| C2 | Gestão do titular: piso de 700 ms podia vazar a existência do número pelo tempo (R5) | **Corrigido por construção**: identificadores gerados antes do banco, resposta imediata e idêntica; processamento depois. Teste com banco lento (300 ms): resposta < 100 ms nos dois casos |
| C3 | D-14 sem SMTP criava convite impossível de ativar | **Corrigido**: 409 e nada é criado; falha de e-mail revoga o convite na hora (502) |
| C4 | Tag GCM de 16 bytes | Exigida na cifra nova (`b5ca1f2`). **Pré-existente fora desta frente:** a decifra do iFood (`cripto.js:89`) também não fixa `authTagLength` — sugerido corrigir na frente iFood |
| C5 | Homologação no Supabase de teste | **Concluída** (30/10): 132–135 aplicar → reverter → reaplicar e 136 aplicada; SQL direto e PostgREST real (anon com chave publicável, membro com JWT real) coincidem item a item — doc 16. Pacote de produção passa a registrar 132–136 em `schema_migrations` na mesma transação (ensaio local 95/95) — doc 15 §5 |

**Regressão final × main (`9da8210`):** backend 5782 / 5743 ok / **14 falhas = as mesmas 14 da main, 0 só na branch** / 25 pulados;
frontend 1648 / 0 falhas; navegador 126/127 (a falha `parserFoodDelivery` "dia único" ocorre igual na main); PostgreSQL descartável **79/79**.

**Regressão do checkpoint da 136 (30/10, mesmo ambiente fictício, `node --test test/*.test.js`, TAP comparado teste a teste × main
`9da8210` no mesmo instante):** branch 5724 testes / 5681 ok / 17 falhas + 1 cancelado / 25 pulados; main 5633 / 5591 / 16 + 1 / 25.
**0 falhas só na branch**: as 17 são as mesmas da main (conversas/WhatsApp, checklist, seleção de perfil, retry). Na 1ª execução
completa, `modelo-logistico-temporal.test.js` caiu com `0xC0000005` (o processo Node do Windows, depois dos 32 subtestes passarem);
isolado passou 32/32 três vezes na branch e na main — intermitente do ambiente, não regressão. PostgreSQL descartável **95/95**;
`isolamento-unidades-fuso-136-http.test.js` 15/15 no Supabase de teste (pulado sem `.env.test`).

**PR #55 atualizado (30/10):** head `b76a81a` (commits `eae756b`, `605f076`, `b76a81a` sobre `bce1875`); contém a main `9da8210`,
sem conflito; checks Vercel e Vercel Preview Comments = SUCCESS. **Pré-voo de produção (só leitura):** doc 17 — nada de 132–136 em
produção, dependências iguais às homologadas, sem bloqueios; GO condicionado à confirmação do backup do dia no painel.
