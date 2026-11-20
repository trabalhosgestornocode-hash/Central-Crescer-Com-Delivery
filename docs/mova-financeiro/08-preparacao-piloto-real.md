# MOVA — Execução 08: preparação final do piloto real (20/11/2026)

> Nada publicado. Sem push, PR remoto, merge, deploy, migração em produção, WhatsApp real ou chamada paga.

## 1. H-1 — falhas gerais (corrigido, `6d7b850`)
- Nova consulta `GET /api/mova/falhas-gerais` (exige `financeiro_v2.configurar`): falhas **sem unidade identificada** das conversas que
  atendem a unidade da sessão. Só metadados: identificador técnico, tipo, código, data, estado e tentativas, contagem por tipo e pendentes.
  Nenhum texto, documento ou dado financeiro. Nenhuma unidade fictícia.
- Correção de isolamento que já existia: `/mova/erros` listava as falhas da fila de **todas** as conversas para quem tinha `ver`, e reprocessar
  aceitava qualquer evento. Agora os dois ficam restritos às conversas da unidade.
- Reprocessar uma falha geral exige `configurar`. A operação roda numa transação condicional: registra `REPROCESSAR` (auditado como
  `FALHA_GERAL_REPROCESSADA`) e devolve o evento à fila. Liberar duas vezes ao mesmo tempo resulta numa só liberação. A barreira de duplicidade
  do motor passa a considerar só as decisões posteriores à última liberação, e uma nova entrega do Gateway continua `DUPLICADO`.
- Interface: cartão "Falhas gerais" na aba Processamento, só para quem tem `configurar`.

## 2. Defeitos encontrados na homologação real (corrigidos, `e0c3faa`)
- **Orçamento da IA com o papel real** — a reserva usava `select … for update` em `mova.orcamento_ia`, o que exige UPDATE. O `mova_app`
  (corretamente) só lê o limite. Com o login real, toda reserva falhava e o sistema **não chamava a IA** (resposta conservadora, `ORCAMENTO_INDISPONIVEL`).
  Correção: bloqueio consultivo da transação (`pg_advisory_xact_lock`), que continua serializando as reservas. Teste novo roda o fluxo inteiro **como `mova_app`**.
- **Leituras do worker no modo de produção** — com a autoridade co-localizada, a sessão de banco só era emitida para requisição de pessoa,
  então toda leitura do worker caía em `FINANCEIRO_INDISPONIVEL`. Correção: o worker usa o mesmo caminho de automação do agendador de
  entregadores (`fv2_abrir_sessao`, que **exige concessão ativa** da identidade na unidade), com a referência `automacao:mova`. No banco de teste
  as 3 sessões ficaram como `OPERACAO`, `pode_escrever = false`, identidade de serviço.

## 3. Evidências de isolamento financeiro
| # | Verificação | Evidência |
|---|---|---|
| 1 | Sem escrita no Financeiro de produção | não há credencial de produção no ambiente MOVA; ISO-1/ISO-2: banco sem a marca ⇒ o MOVA não monta (0 leituras) |
| 2–3 | Conexão só com a homologação, banco marcado | marca conferida no banco do MOVA **e** no do Financeiro (`exigirBancoDeHomologacao`); `iniciar-backend.mjs` recusa a referência de produção |
| 4 | Configuração de produção recusada | ISO-3/ISO-4: segredo igual ao principal ⇒ rota inexistente (HTTP 404) e worker parado; modo/ambiente/marca ausentes ⇒ bloqueio |
| 5 | Segredo próprio do canal | `MOVA_GATEWAY_SECRET` ≠ `WHATSAPP_GATEWAY_SECRET` (configuração e Gateway recusam igual) |
| 6, 11 | Propostas fictícias e aplicação só no teste | aplicação real no projeto de teste: 1 obrigação/lançamento/liquidação/movimentação **só na Centro**, 0 nas outras |
| 7 | Dados fictícios | org e unidades `[MOVA-HML]`, JID fictício, IA simulada na rede |
| 8–9 | Outros contatos e grupos fora | conversa não autorizada ⇒ ignorada sem registro; grupo não autorizado ⇒ ignorado |
| 10 | Serviço sem poder administrativo | ISO-10: serviço não configura, não vê falhas gerais e não aplica; concessão CONSULTA; sessões `pode_escrever=false` |
| 12 | Suspensão imediata | homologação: suspenso ⇒ recebimento descartado na hora; retomada volta a enfileirar |

## 4. Homologação local (projeto de teste, backend real, IA simulada na camada de rede)
- Rodada 1 (`homologar.mjs`): **22/22**. Canal (sem assinatura, segredo errado, repetição, expiração ⇒ 401), duplicado, filtros, estado em HOMOLOGAÇÃO,
  orçamento, H-1 visível e sem conteúdo, reprocessar, suspensão/retomada, isolamento (403 nas unidades sem concessão).
- Rodada 2 (`homologar2.mjs` + `homologar3.mjs`): 3 eventos ⇒ **3 chamadas** dentro do orçamento (US$ 0,078 simulados); proposta só da Centro visível;
  Shopping com `REQUISITOS_FINANCEIROS_INCOMPLETOS`; Açaí aguardando (sem administrador); aplicar sem conta ⇒ 400; **aplicada** no Financeiro de teste;
  aplicar de novo ⇒ 409; aprovação registrada.
- Login real (senha + TOTP ⇒ aal2), contexto da plataforma, bootstrap, administração corporativa e liberações já feitos na Execução 07.
- Contas fictícias: administradora com FINANCEIRO completo na Centro; **Açaí e Shopping sem administrador financeiro** (bootstrap é de uso único e
  ninguém concede acesso a si mesmo — não contornado). Shopping liberada **só para consulta**.

## 5. Sincronização
`origin/main` = `78cfe12` (inalterada desde a Execução 06): nada a integrar, sem conflitos.

## 6. Testes
MOVA PostgreSQL 96/96 · MOVA memória 27/27 · Financeiro v2 732/732 · Gateway 1092/1092 · frontend 2040/2040 · navegador 6/6 (desktop, 375 px, escuro,
API, desligado, homologação) · backend completo: só as falhas preexistentes (Central de Conversas/visão, migrations 088 e 103, distribuições,
selecionarPerfil) e uma intermitente conhecida (dashboard-executivo, 30/30 isolada). IA e WhatsApp simulados.

## 7. Plano de publicação (cada fase com autorização própria, no momento)
**Pré-requisito**: push da branch e PR revisado → merge (o merge na `main` dispara o deploy automático do backend; prévias de PR estão desligadas).

**Fase A — publicação passiva**
1. Merge ⇒ deploy automático do backend com o MOVA **sem variáveis** (rota `/internal/mova` inexistente; worker desligado).
2. Conferir `/health`, as telas do Financeiro e o log `MOVA: DESABILITADO (DESLIGADO)`.
3. Gateway: deploy manual do mesmo commit **sem** `WHATSAPP_MOVA_*`, em janela de pouco movimento. Conferir a reconexão Baileys (≤ 2 min),
   o log `mova.config ativo:false` e as mensagens automáticas existentes (um envio automático de rotina chega).

**Fase B — recebimento privado**
1. Backend MOVA de homologação (local ou serviço aprovado) com `MOVA_RECEBIMENTO_HABILITADO=1` e o resto desligado.
2. Gateway: `WHATSAPP_MOVA_BACKEND_URL`, `WHATSAPP_MOVA_BACKEND_SECRET`, `WHATSAPP_MOVA_HOMOLOGACAO_CONTATO`, `…_CONFIRMACAO` ⇒ reinício (reconexão).
   Exige túnel público até o backend local **ou** serviço de homologação publicado.
3. O contato autorizado envia um texto fictício ⇒ evento assinado chega; outro contato e grupos não chegam.

**Fase C — processamento**: `MOVA_PROCESSAMENTO_HABILITADO=1`, `MOVA_IA_HABILITADA=1` e uma chave Anthropic **de homologação**. Orçamento de
20 chamadas / US$ 1. Conferir as propostas no banco de homologação e o consumo.

**Fase D — respostas**: `MOVA_ENVIO_HABILITADO=1` + `MOVA_GATEWAY_URL`. Conferir uma resposta ao contato autorizado, sem duplicidade
(lease + idempotência), além das falhas e do consumo.

## 8. Plano de reversão
**Suspensão funcional (sem tocar no WhatsApp; testada na homologação)**
- "Suspender tudo agora" (aba Processamento) ou interruptores individuais: recebimento, processamento, IA e envio, com efeito em ≤ 5 s.
- Persistente: `MOVA_SUSPENSO=1` no backend MOVA (reinicia só o MOVA). O Gateway segue igual; os eventos do canal são descartados.

**Reversão de código**
- Backend: redeploy do deploy anterior no Render (hoje `78cfe12`). Sem migração de plataforma nem do Financeiro nesta branch ⇒ volta direta.
- Gateway: redeploy manual do commit no ar hoje (`e7614e4`, código idêntico ao Gateway da `main`). Reinicia o processo ⇒ reconexão. A sessão e as
  credenciais Baileys ficam guardadas cifradas pelo backend e não são tocadas (não apagar arquivos de sessão, não reparear).
- Banco do MOVA: migrações só aditivas, no schema `mova` do banco de homologação. Nada a desfazer em produção. O código antigo ignora o schema `mova`.

**Critérios de interrupção** (responsável: quem estiver operando a fase — proprietário ou pessoa designada por ele)
| Situação | Verificação | Ação imediata |
|---|---|---|
| Envio a contato não autorizado | log `mova.envio`/`resposta` com destino ≠ contato | Suspender tudo; `MOVA_ENVIO_HABILITADO=0`; investigar antes de religar |
| Mensagem de grupo real processada | Caixa/decisões com grupo ≠ contato | Suspender; remover `WHATSAPP_MOVA_*` do Gateway na próxima janela |
| Escrita/consulta em produção | marca do banco; credenciais do serviço | Parar o backend MOVA; trocar as credenciais |
| Instabilidade Baileys | desconexões > 2 min, fila de saída parada | Reverter o Gateway para `e7614e4` |
| Envios automáticos interrompidos | rotina não chega | Reverter o Gateway; abrir incidente |
| Resposta/proposta duplicada | contagem por evento/idempotência | Suspender o envio; conferir lease e fila |
| Violação de permissão | 200 onde deveria ser 403 | Suspender tudo; revogar concessões |
| IA inesperada | consumo fora do previsto, conteúdo indevido | `MOVA_IA_HABILITADA=0`; reduzir o orçamento |

## 9. Riscos remanescentes
- **R-1 Reinício do Gateway**: toda fase com Gateway reconecta a sessão (janela de segundos).
- **R-2 Custo em falha transitória**: depois da leitura da IA, uma falha transitória (ex.: Financeiro fora) faz a fila tentar de novo e **chamar a IA
  outra vez** (até 5 tentativas). Limitado pelo orçamento; melhoria futura: reaproveitar a leitura já feita do evento.
- **R-3 Backend local**: sem disponibilidade contínua; o WhatsApp real precisa de túnel ou serviço publicado.
- **R-4 Açaí/Shopping sem administrador financeiro** no ambiente de teste (exige uma 2ª conta fictícia administradora).
- **R-5** Uma falha intermitente conhecida no backend completo (dashboard-executivo), sem relação com o MOVA.
