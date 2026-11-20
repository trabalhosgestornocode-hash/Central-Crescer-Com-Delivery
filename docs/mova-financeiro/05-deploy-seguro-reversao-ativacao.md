# MOVA — Execução 05: deploy seguro, reversão e ativação progressiva

> Situação: **preparado e testado localmente. Nada publicado, nada ativado, nenhuma mensagem real, nenhuma migração em produção.**
> A homologação pelo WhatsApp **não está concluída** — depende das autorizações do item 12.

## 1. Diagnóstico da infraestrutura (leitura apenas, 20/11/2026)

| Serviço | Tipo | Deploy | Situação |
|---|---|---|---|
| Gateway WhatsApp (Baileys) | serviço privado, Docker, **1 instância** | **automático DESLIGADO** | commit no ar = código do Gateway idêntico à `main` |
| Backend da plataforma | web service | automático ligado na `main` | no ar = `main` atual |

- O Gateway mantém **uma única sessão** do WhatsApp (lease de liderança + estado de autenticação cifrado guardado pelo backend).
- **Qualquer deploy do Gateway reinicia o processo ⇒ o socket reconecta.** A sessão não é perdida (credenciais persistidas), mas há uma janela de segundos sem conexão; mensagens que chegarem nela são entregues pelo WhatsApp na reconexão (sincronização offline do companion). Isto é tratado como **bloqueador de publicação até a janela ser escolhida e acompanhada** (item 10).
- A branch do MOVA está 2 commits atrás da `main` (nenhum toca o Gateway nem a comunicação). Rebase obrigatório antes de qualquer PR.

## 2. Componentes

```
WhatsApp ── Gateway atual (mesma sessão) ──► filtro: SÓ o contato privado autorizado (verificado pelo próprio WhatsApp)
                │                                   │
                │ fluxo normal intocado             ▼  canal ISOLADO (URL + segredo HMAC próprios)
                ▼                              Backend MOVA de HOMOLOGAÇÃO (serviço separado)
        Backend de produção                     │ recebimento → fila → processamento → IA (orçamento) → proposta fictícia
        (não conhece o MOVA)                    ▼
                                           Banco de HOMOLOGAÇÃO (marcado) ── resposta opcional ──► Gateway /internal/mova/messages
```

Arquivos novos/alterados nesta execução:
- `database/mova-financeiro/migracoes/0004_mova_controle_orcamento.sql` — interruptores (`mova.controle`) e orçamento persistente (`mova.orcamento_ia`, `mova.consumo_ia`). Aditiva, só schema `mova`.
- `backend/src/modules/mova-financeiro/infra/operacao.js` — controle com efeito imediato, reserva de orçamento **antes** de cada chamada, cliente da IA embrulhado.
- `backend/src/modules/fv2-integracao/mova.js` — configuração com detecção de contradições, trava do banco de homologação, router isolado `/internal/mova`, worker/enviador embutidos (desligados por padrão), envio pelo canal isolado.
- `gateway-whatsapp/src/movaCanal.js` — cliente do canal isolado (re-tentativa limitada, limite de taxa, nunca lança).
- Interface: aba **Processamento** (interruptores, orçamento, fila, erros, reprocessar), revisar categoria, abrir documento autorizado, faixa **HOMOLOGAÇÃO**.

## 3. Configurações (nomes apenas — valores só no painel do serviço, nunca no repositório)

**Backend MOVA de homologação**

| Variável | Papel |
|---|---|
| `MOVA_HABILITADO=1` | base |
| `MOVA_DATABASE_URL` | banco de homologação (papel membro de `mova_app`) |
| `MOVA_SERVICO_USUARIO_ID` | identidade de serviço (concessão só nas unidades de teste) |
| `MOVA_MODO=HOMOLOGACAO`, `MOVA_AMBIENTE=homologacao`, `MOVA_HOMOLOGACAO_MARCADOR` | as três juntas; o banco MOVA **e** o do Financeiro precisam do comentário `MOVA_HOMOLOGACAO:<marcador>` |
| `MOVA_GATEWAY_SECRET` | HMAC do canal (≥ 32, **diferente** do `WHATSAPP_GATEWAY_SECRET`) |
| `MOVA_GATEWAY_URL` | só para envio |
| `MOVA_RECEBIMENTO_HABILITADO` / `MOVA_PROCESSAMENTO_HABILITADO` / `MOVA_IA_HABILITADA` / `MOVA_ENVIO_HABILITADO` | etapas, cada uma exige a anterior |
| `MOVA_SUSPENSO=1` | desliga tudo |
| `ANTHROPIC_API_KEY` | só com IA ligada |

**Gateway (produção)**: `WHATSAPP_MOVA_BACKEND_URL`, `WHATSAPP_MOVA_BACKEND_SECRET` (mesmo valor do `MOVA_GATEWAY_SECRET`), `WHATSAPP_MOVA_HOMOLOGACAO_CONTATO` (o número autorizado — **só aqui**), `WHATSAPP_MOVA_HOMOLOGACAO_CONFIRMACAO=privada-somente-homologacao`. Sem grupos MOVA (`WHATSAPP_MOVA_GRUPOS_JID` vazio). Sem o canal completo, o MOVA **não liga** no Gateway.

Bloqueios automáticos (testados): ausência de credenciais; modo de homologação parcial; marcador inválido; processamento sem recebimento; IA ou envio sem processamento; envio sem Gateway; canal sem segredo; segredo igual ao principal; banco compartilhado fora da homologação; modo desconhecido; banco sem o marcador.

## 4. Ambiente de homologação necessário (não criado)

1. Banco separado (projeto/instância própria) com as migrações do Financeiro v2 + `mova/0001..0004`, unidades **de teste** e o comentário-marcador.
2. Serviço backend separado com as variáveis acima (sem nenhuma variável de produção).
3. Contas de teste fictícias no Financeiro de homologação.

## 5. Estado da sessão Baileys

Sessão atual em uso pelo fluxo normal, conectada; nenhuma alteração feita. O MOVA usa o **mesmo socket** (sem segunda sessão, sem pareamento, sem mexer em credenciais ou arquivos de sessão). Mensagens automáticas e lógica de grupos não foram alteradas (suíte do Gateway 1092/1092).

## 6. Controles

| Controle | Onde | Efeito |
|---|---|---|
| Etapas pela configuração | variáveis do serviço | precisa reinício do serviço **MOVA** (não do Gateway) |
| Interruptores em tempo real | `mova.controle` / aba Processamento (permissão configurar) | imediato (cache ≤ 5 s); recebimento desligado ⇒ aceita e descarta; processamento desligado ⇒ eventos ficam intactos na fila |
| Suspensão geral | idem, botão "Suspender tudo agora" | imediato, auditado |
| Orçamento IA | `mova.orcamento_ia` (200 chamadas / US$ 10; começar com 20 / US$ 1) | reserva antes da chamada; banco fora ⇒ não chama |
| Limite de taxa | canal do Gateway (30/min) e envio (5 por rodada) | excesso descartado / adiado |
| Própria mensagem | Gateway e receptor | ignorada |
| Duplicados | fila por `eventoId` + lease de envio | um processamento, um envio |
| Contato | verificado pelo WhatsApp a partir do evento autenticado; nenhum poder administrativo por número | |

## 7. Plano de publicação (cada fase exige autorização explícita)

0. **Pré-publicação**: rebase na `main`; suíte completa; criar banco e serviço de homologação; aplicar migrações **só** no banco de homologação; marcar o banco; orçamento reduzido (20 chamadas / US$ 1); tudo desligado.
1. **Publicação passiva**: deploy do backend MOVA de homologação (tudo desligado) → conferir `/health` e aba Processamento. Merge do código no backend de produção é inócuo (sem variáveis ⇒ router nem existe), mas **só com aprovação**.
2. **Gateway**: deploy manual do Gateway com as variáveis do canal, em janela de baixo movimento, acompanhando os logs (`mova.config` deve mostrar `canal: ATIVO`, `homologacaoPrivada: true`). Critério de parada: qualquer desconexão que não volte em 2 minutos ⇒ reverter (item 8).
3. **Recebimento**: ligar `MOVA_RECEBIMENTO_HABILITADO`; o contato autorizado envia **texto fictício**; conferir Caixa de Entrada; nenhuma outra conversa aparece.
4. **Processamento + IA**: ligar processamento e IA; 3–5 mensagens fictícias; conferir orçamento e propostas.
5. **Envio**: ligar envio; uma resposta ao contato autorizado; conferir que nada foi a outras conversas.
6. **Observabilidade**: logs `mova.*` no Gateway; aba Processamento (fila, erros, orçamento); auditoria `mova.auditoria`.

**Critérios de parada imediata**: mensagem de conversa não autorizada na Caixa; qualquer envio fora do contato; consumo acima do previsto; erro no fluxo normal do Gateway; desconexão do WhatsApp.

## 8. Plano de reversão

- **Funcional (sem tocar no WhatsApp)**: "Suspender tudo agora" (ou `update mova.controle set suspenso = true`), depois `MOVA_SUSPENSO=1` no serviço MOVA. O Gateway continua conectado; eventos do canal passam a ser descartados.
- **Gateway sem MOVA, sem redeploy de código**: remover `WHATSAPP_MOVA_BACKEND_URL` exige reinício (reconexão) — preferir a reversão funcional.
- **Código**: Gateway ⇒ redeploy do commit anterior (o que está no ar hoje); backend ⇒ redeploy do deploy anterior no Render. O backend de produção não precisa de reversão de dados: sem variáveis, nada do MOVA existe nele.
- **Schema**: migrações só aditivas no schema `mova` do banco de **homologação**; nenhum DROP destrutivo (teste 21); produção não recebe migração do MOVA.
- Simulado em isolamento: interruptores e suspensão (teste 20), app.js volta ao normal sem env (teste 21).

## 9. Testes

| # | Item | Evidência |
|---|---|---|
| 1 | MOVA desligado | execucao05 01; execucao03 30 |
| 2 | Gateway sem MOVA | movaCanal (sem canal ⇒ desligado); suíte do Gateway 1092/1092 |
| 3 | mensagens automáticas preservadas | suíte do Gateway |
| 4–6 | contato autorizado / não autorizado / grupo não autorizado | homologacaoPrivada; execucao05 25/26 |
| 7 | própria conta | cenarios, receptor |
| 8 | evento duplicado | cenarios |
| 9 | falha Anthropic | execucao03 |
| 10 | falha backend MOVA | movaCanal (re-tentativa limitada, nunca lança) |
| 11 | falha banco homolog | execucao05 11; cenarios |
| 12–13 | reinício worker / reconexão Gateway | execucao03; fila com lease |
| 14–15 | credenciais ausentes / config contraditória | execucao05 01/14/15 |
| 16 | envio não autorizado | homologacaoPrivada (jidAutorizadoParaEnvio); canal exclusivo do envio |
| 17 | banco produtivo | execucao05 17 |
| 18 | lançamento real | aprovador exige concessão + escrita liberada na unidade (cenarios) |
| 19 | limite de custo | execucao05 19 |
| 20–21 | reversão funcional / de código | execucao05 20, 21 |
| 22 | sessão Baileys preservada | sem alteração de sessão/credenciais; suíte do Gateway |
| 23 | interface homolog | navegador 6/6 (faixa, Processamento, ações) |
| 24 | três unidades | cenarios / execucao05 27 (unidade alheia ⇒ 404) |
| 25–26 | HMAC / expiração e repetição | execucao05 25/26 |
| 27 | evidências | execucao05 27 (permissão, unidade, adulteração ⇒ 409) |

Resultados: MOVA 84/84 (PostgreSQL local), Gateway 1092/1092, Financeiro v2 732/732, frontend 2038/2038 (+ navegador 6/6), backend completo só com falhas **pré-existentes** (Central de Conversas/visão, migrations 088/103, distribuições, selecionarPerfil; arquivos que exigem `--experimental-vm-modules` passam com a flag).

## 10. Riscos e bloqueadores

- **B1 — reinício do Gateway**: todo deploy reconecta o socket. Mitigação: janela de baixo movimento, acompanhamento, reversão pelo commit anterior. Precisa de aceite explícito.
- **B2 — ambiente de homologação inexistente** (banco + serviço). Criar exige autorização (custo).
- **B3 — branch atrás da `main`**: rebase antes do PR.
- R1 — contato autorizado é o único caminho; se o número mudar, só a variável muda.
- R2 — custo da IA limitado pelo orçamento persistente; começar baixo.
- R3 — repositório público: nenhum número, nome ou identificador real no código/documentação (conferido).

## 11. Commit

Commit local na branch `feat/mova-centro-financeiro` (sem push).

## 12. Checklist de autorização (cada item separado, com palavras do responsável)

- [ ] Criar banco e serviço de homologação (custo mensal)
- [ ] Aplicar migrações no banco de **homologação**
- [ ] Merge na `main` (backend de produção recebe código inócuo)
- [ ] Deploy do backend MOVA de homologação (tudo desligado)
- [ ] Deploy do Gateway com o canal (reconexão — janela definida)
- [ ] Ligar recebimento
- [ ] Ligar processamento + IA (orçamento inicial)
- [ ] Ligar envio
- [ ] Encerrar ou ampliar o piloto
