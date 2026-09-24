# Central de Comunicação — Conversas e Conexão (migrations 096 e 097)

Status: implementado em `feat/comunicacao-central-conversas` (base origin/main 467c8d2). **Não commitado, não deployado, migrations NÃO aplicadas em banco algum.**

## Princípios inegociáveis
- Não toca no offline recovery. Não altera os gates de segurança existentes (só acrescenta o gate `CONEXAO_NAO_CONFIRMADA` ao envio manual).
- A Central **não** é uma visão de todo o WhatsApp conectado: só números cadastrados como responsáveis (perfil ativo + vínculo ativo com organização) são reconhecidos, **no servidor**.
- Nada de telefone completo, token, auth state, HMAC, QR persistido, histórico de QR ou chaves Signal na API, no DOM, em log ou em auditoria.

## Abas
Visão Geral · Conversas · Automações · Histórico · Destinatários · Conexão · Configurações (diagnóstico técnico dentro de Configurações).

## Fluxo de entrada (inbound)
`messages.upsert` (Gateway) → `inboundContrato` (ignora grupo/status/broadcast/newsletter; extrai só texto/tipo) → backend `processarInbound` → JID canônico → **roster** (view `comunicacao_roster_autorizado`) → autorizado: grava em `comunicacao_inbox_mensagens`; desconhecido: **ignorado**, não persistido, entra só numa métrica agregada (sem conteúdo, sem telefone). O ledger 090 deixou de gravar o telefone de números desconhecidos.

Um telefone com várias unidades = **uma** conversa (chips de unidade). Busca por nome/empresa/unidade, nunca por telefone completo.

## Retenção (real, em três camadas)
Texto recebido: **30 dias** (`COMUNICACAO_INBOX_RETENCAO_DIAS`, 1..365). Mídia: só o tipo, sem conteúdo.
1. **Leitura**: nenhuma consulta passa do corte (`dentroDaRetencao`; `comunicacao_inbox_resumo` filtra) — texto vencido nunca aparece, nem antes da purga.
2. **Purga oportunista** dentro de `comunicacao_inbox_registrar` (por organização, lote de 200).
3. **Purga periódica** `comunicacao_inbox_purgar` (SQL 096), chamada pelo processo web a cada 6 h (`COMUNICACAO_INBOX_PURGA_INTERVALO_MIN`, 5..1440; `0` desliga) — independe de tráfego novo **e do worker de automação** (que pode estar desligado). Só o inbox é purgado: outbox, contatos e auditoria nunca.

## Atualização ao vivo
Polling por **cursor** (`GET /central/atualizacoes`): 8 s em Conversas/Visão Geral, 30 s nas demais, **nenhum com a aba oculta**; ao voltar ao primeiro plano, uma única consulta imediata. Uma consulta em voo por vez (eventos repetidos não duplicam), o cursor do cliente é **monotônico** (`avancarCursor`: nunca recua, nem com resposta atrasada ou purga), o servidor compara com **5 s de sobreposição** (commit fora de ordem não se perde; o resultado é um conjunto de ids = deduplicado) e sair da tela cancela tudo. Cada aba visível consulta por conta própria (2 consultas indexadas `limit 1` + resumo); abas ocultas não consultam. Não foi criado tópico Realtime novo (a infra existente não cobre o inbox; decisão do usuário). Conexão: QR a cada 2 s com contagem regressiva de 1 s; estado a cada 10 s.

## Envio manual
Reusa o pipeline existente (outbox + RPCs com fencing `comunicacao_iniciar_envio`/`finalizar_envio` + `WhatsAppService` → onWhatsApp → JID canônico → HMAC → Gateway → Baileys → recibos/RPC 095). Origem `manual_painel`, operador humano registrado, idempotência `wa:manual:{envioId}:v1`, sem retry automático, falha ambígua → "Tentar de novo" com o **mesmo** envioId. Gates fail-closed: contato existe, consentimento, verificado, sem opt-out, JID válido, Gateway conectado, allowlist do piloto, **identidade da conta confirmada**.

## Gate de conta confirmada (`CONEXAO_NAO_CONFIRMADA`) — todos os caminhos
`CONNECTED` sozinho **não basta**. Só existe "confirmada" quando o Gateway está conectado (heartbeat fresco) **e** o hash (sha256 do E.164 do JID conectado) é o que o operador confirmou (`comunicacao.identidade.js`, módulo neutro). Não é um booleano solto: é a conta concreta — restart da mesma conta preserva; outra conta invalida; desconectar zera; durante QR/conectando/reconectando/troca/pendente ⇒ provider = 0. Aplicado em: envio manual e teste controlado (gate + 409), **política do worker** (`IDENTIDADE_NAO_CONFIRMADA`, transitório: adia sem consumir tentativa) e o **`WhatsAppService`** — único chamador do provider — que recusa qualquer envio (texto/imagem/documento) sem gate injetado (fail-closed; `semGateIdentidade` existe só para testes e um teste estático proíbe em código de produção).

## Multi-tenant (modelo)
`organizacao_id` do inbox, da leitura ("lida") e da identidade é a organização da **conexão** (a Crescer); os responsáveis pertencem às organizações-cliente do roster. Toda leitura do inbox filtra por essa organização; "lida" é por (conexão, contato); a identidade e a trava são por (organização, instância). O banco recusa (`P0001`) registrar texto de contato fora do roster (defesa em profundidade além do backend).
A linha nasce `PROCESSING` com `expira_em` ≤ lease para que o claim do worker nunca a pegue.

## Aba Conexão
Estados: Conectado / Desconectado / Conectando / Aguardando leitura do QR Code / Reconectando / Sessão inválida.
- Assistente: preparar sessão → gerar QR → aguardar leitura → validar conta → obter perfil → concluir. Após ler o QR a conexão fica **PENDENTE_CONFIRMACAO** ("WhatsApp identificado"); envio manual bloqueado até *Confirmar conexão*. *Cancelar* = reset da sessão.
- QR: a string fica só na memória do Gateway; o Gateway renderiza um **SVG** (`qrSvg.js`); o backend devolve só o `svg`; o front usa `<img data-url>`. Removido ao conectar/fechar; retirado do payload do heartbeat.
- Identidade interna (nome operacional "Agente Crescer", ambiente Teste/Produção) separada da identidade do WhatsApp; guarda-se apenas o **hash** do número confirmado. Outro número ⇒ confirmação e nome deixam de valer.
- Desconectar: modal de alto impacto + confirmação explícita; `logout()` best-effort + `resetarSessao` existente; histórico preservado. Trocar número: sequência segura sem sessões concorrentes.
- Trava de operação (RPC `whatsapp_operacao_iniciar/encerrar`, TTL 300 s): uma operação por vez.
- Permissão `comunicacao:gerenciar_conexao` (tabela `painel_adm_permissoes`; SuperAdmin passa por bypass; fail-closed). Sem ela a aba é somente leitura; 403 de permissão **não** derruba o acesso ao painel.
- Auditoria: WHATSAPP_CONEXAO_INICIADA, WHATSAPP_QR_GERADO, WHATSAPP_CONECTADO, WHATSAPP_DESCONECTADO, WHATSAPP_CONEXAO_FALHOU (sem QR/segredos).

Conceder a permissão (SQL, uma vez):
```sql
insert into painel_adm_permissoes (usuario_id, permissao)
values ('<auth.users.id>', 'comunicacao:gerenciar_conexao');
```

## Variáveis de ambiente novas
`COMUNICACAO_INBOX_RETENCAO_DIAS` (30), `COMUNICACAO_INBOX_PURGA_INTERVALO_MIN` (360; 0 = desliga a purga periódica).

## Endpoints do Gateway (novos, HMAC)
`GET /whatsapp/qr`, `GET /whatsapp/perfil`, `POST /whatsapp/desconectar-conta`, `POST /whatsapp/perfil-foto`.

## Ordem de deploy (quando aprovado)
1. Migration 096, depois 097 (aditivas; rollbacks `096_rollback.sql`, `097_rollback.sql`). O backend tolera 096 ausente (degrada sem inbox).
2. Gateway (contrato de evento v2 + endpoints de conexão).
3. Backend, depois frontend.
4. Conceder `comunicacao:gerenciar_conexao` ao(s) operador(es); confirmar a conta na aba Conexão antes de qualquer envio manual.

## Limitações e dívida conhecida
- Migrations validadas só contra o fake em memória e por análise estática, **não** contra Postgres real.
- A lógica de DOM dos controllers é verificada por roteiro em Chrome headless (fora do repositório) e por testes das funções puras, não por testes unitários de DOM.
- O caminho do worker (automações) não é barrado pela confirmação de identidade; só o envio manual.
- Eventos `contacts.update` de foto não são usados; a foto vem sob demanda de `profilePictureUrl`, com cache e fallback de iniciais.
- Código legado da aba antiga (`htmlCardsSaude`, `htmlSaudeComunicacao`, `htmlFluxoComunicacao`, `htmlEmpresasCentral`, `htmlHistoricoCentral`, `htmlConfiguracoesCentral`, `htmlAbasCentral` em `painelAdmCentral.js`; `htmlComunicacao*`, `pintarComunicacao`, `carregarSubAbaComunicacao`, `ligarComunicacao` em `painelAdmViews.js`) está sem uso na tela nova e ainda coberto por `painelAdmCentral.test.js` / `painelAdmComunicacao.test.js`. Remover em commit separado.
