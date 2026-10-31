# 02 — Auditoria das notificações existentes

> Somente leitura. Produção consultada só por catálogo e contagens agregadas (30/10/2026, nenhum telefone ou nome).

## 1. Mapa dos mecanismos

| Mecanismo | Código | Banco | Estado em produção |
|---|---|---|---|
| **Aviso D-1 do Dashboard iFood** (pendência de lançamento do dia anterior), com **reforço** 20:00–22:00 e **aviso tardio** | `comunicacao.alertas.service.js` (`executarCiclo`, 888 linhas), `comunicacao.reforco.js`, `comunicacao.template.js`, `administrativo.status.js` (detecção) | `comunicacao_alertas` → `comunicacao_mensagens` (082, 088, 092, 094, 100, 104) | **Ativo**: `modo = NORMAL`; 39 empresas configuradas, 38 com `habilitado` e `envio_automatico`; 1.174 mensagens D-1 nos últimos 30 dias (DELIVERED 665, READ 102, SENT 113, CANCELLED 294, SCHEDULED 8) |
| **Relatório diário ao grupo interno** (equipe Crescer) | `relatorioDashboardGrupo.js`, `comunicacao.grupoInterno.js` | `comunicacao_envios_grupo` (109) | Ativo: 19 relatórios + 1 teste em 30 dias |
| **Envio manual / teste** pelo Painel ADM | `comunicacao.manual.js`, `administrativo.comunicacao.teste.js` | `comunicacao_mensagens` (`tipo = mensagem_manual`) | 8 em 30 dias |
| **Central de Comunicação** (conversas, inbox, visão geral, destinatários, histórico, diagnóstico) | `administrativo.comunicacao.conversas.js`, `comunicacao.inbox.*`, frontend `central/` | `comunicacao_inbox_mensagens`, view `comunicacao_roster_autorizado` (090, 096) | Ativa para a equipe; 6 mensagens recebidas em 30 dias |
| **Gateway WhatsApp** (Baileys 6.7.24, serviço privado) | `gateway-whatsapp/` | `whatsapp_conexoes` (083–099), cache de retry (105) | **1 conexão `baileys/CONNECTED`**, identidade confirmada |
| **Fechamento operacional (WhatsApp simulado)** | `checklistOperacional.whatsapp.js` | `operacional_mensagens_simuladas` (130, `CHECK transporte='noop'`) | Só simulação; 0 linhas |
| Tabelas legadas `alertas`/`notificacoes` | schema base | sem `organizacao_id` | **Mortas**: descartadas pela 082, não reutilizar |
| Página Configurações → Notificações | `configuracoes.js:528` | — | Placeholder |

## 2. Pipeline do D-1 (preservar integralmente)

```
administrativo.status.js (pendência D-1 por UNIDADE)
  → comunicacao_alertas (1 por unidade/dia/tipo, dedupe)            [detectarESincronizarAlertas]
  → comunicacao_agendar_mensagens_alerta (RPC 104: 1 msg por DESTINATÁRIO, atômica, chave alerta+destinatário+propósito)
  → comunicacao_mensagens SCHEDULED
  → comunicacao_claim_mensagens (FOR UPDATE SKIP LOCKED, lease)       [worker embutido, COMUNICACAO_WORKER_ENABLED + modo]
  → JIT: pendência ainda existe? → policy (avaliarEnvio, pura, fail-closed)
  → comunicacao_reservar_envio (rate-limit por minuto / contato-dia / org-dia, cooldown por destinatário — atômico)
  → whatsapp.service.js (único chamador do provider) → gateway HTTP+HMAC → Baileys
  → tentativas (comunicacao_tentativas) · status do provider (095) · alerta agregado (comunicacao_status_agregado_alerta)
```

Regras vigentes (`comunicacao_configuracoes` em produção):
- **janelas:** seg–sex 08–18, sáb 08–13, dom nenhuma;
- **limites:** 3 por contato/dia e 5 proativas por minuto;
- **cooldown:** 8 h (atenção) e 4 h (crítico);
- **reforço:** só D-1 que vence hoje, 20:00–22:00 com jitter, corte 22:30, nunca domingo, ≥ 2 h após o envio real (`docs/comunicacao-reforco-d1.md`).

## 3. Respostas às perguntas da missão

1. **Onde os números são cadastrados?**
   - Em `comunicacao_contatos_empresa` (100/104), pelo **Painel Administrativo** (`POST /administrativo/comunicacao/organizacoes/:id/destinatarios`).
   - Cada linha aponta para `contatos_whatsapp` (082), um registro **global por telefone** (`telefone_e164` único) que guarda `verificado`, `consentimento` e `opt_out`.
   - Produção: 41 destinatários (39 principal, 1 secundário, 1 operacional), em 39 empresas, sobre 29 números distintos. **5 números estão ativos em mais de uma empresa.**
2. **Como se relacionam às unidades?**
   - **Não se relacionam.** O destinatário é por **empresa** (`organizacao_id`); o alerta é por **unidade** (1.405/1.405 com `unidade_id`).
   - O responsável da empresa recebe os avisos de **todas** as unidades. Hoje isso vale para 37 empresas com 1 unidade e 1 com 6.
   - Limitação documentada: a cota de 3 por contato/dia pode se esgotar em empresa com várias unidades pendentes (`comunicacao-reforco-d1.md`, "Limitações").
3. **Como são autorizados?**
   - Um operador do Painel ADM clica em "autorizar" com `confirmacaoExplicita = true` (`administrativo.comunicacao.empresa.js:190`).
   - Isso chama `validarWhatsApp` (`comunicacao.contatosEmpresa.repo.js:209`), que:
     - marca **ao mesmo tempo** `verificado = true` e `consentimento = true` no **registro global do telefone** (`confirmarConsentimentoEVerificacao`);
     - marca `whatsapp_status = VALIDADO` no vínculo com a empresa.
   - É **atestado do operador**: não há prova de posse do número, nem ação do titular, nem texto ou versão do consentimento, nem categoria.
   - Produção: 29/29 números com `verificado` e `consentimento` true, 0 opt-out; 41/41 destinatários VALIDADO.
4. **Quem pode modificá-los?** Só usuários do Painel Administrativo (`requirePainelAdministrativo` no router inteiro, `administrativo.routes.js`). O cliente não tem tela nem rota.
5. **Como o envio é registrado?**
   - `comunicacao_mensagens`, com snapshot de empresa/contato/telefone e data de referência (100), status, `enviado_em`/`entregue_em`/`lido_em` e idempotência.
   - `comunicacao_tentativas` registra cada tentativa com resultado e classificação de erro.
   - A auditoria de plataforma registra os atos administrativos (`ACOES.COMUNICACAO_*`).
   - O log do worker bloqueia campos sensíveis (`worker-comunicacao.logsafe.js`).
6. **Falhas:**
   - classificação RETRYAVEL / PERMANENTE / INCERTO (`comunicacao_tentativas.erro_classificacao`);
   - até `max_tentativas = 5`;
   - `DELIVERY_UNKNOWN` **nunca é reenviado automaticamente**;
   - lease expirado devolve à fila (`comunicacao_expirar_entregas_incertas`);
   - adiamento transitório (fora da janela, pausa) nunca vira bloqueio permanente (`comunicacao.adiamento.js`);
   - reenvio sob retry do protocolo com allowlist por contato (105, `retryResendAllowlist.js`).
7. **Disparos duplicados:**
   - índice único `alerta + destinatário + propósito` (104);
   - chaves `wa:alerta:{id}:v1` e `…:reforco:v1`;
   - claim com lease e `claim_geracao` (087, fencing);
   - `comunicacao_reservar_envio` atômico;
   - grupo interno com `UNIQUE(chave_idempotencia)` (109).
8. **Reutilizável:**
   - a **policy pura** (`avaliarEnvio`), que já separa opt-out, verificação, consentimento, categoria, janela, pausa, limites e identidade;
   - a fila com claim/lease/fencing;
   - `comunicacao_reservar_envio`;
   - o catálogo `comunicacao_categorias`, `comunicacao_destinatario_categorias` e a função `comunicacao_resolver_destinatarios`;
   - a máscara de telefone (`mascararTelefone`);
   - o contrato `whatsapp.provider.js`;
   - o log seguro e a auditoria.
9. **Comportamentos a preservar:**
   - o D-1 com reforço e aviso tardio exatamente como estão (horários, corte, domingo, cotas, chaves);
   - o envio automático das 38 empresas;
   - o relatório ao grupo interno;
   - a Central de Comunicação da equipe;
   - o "fail-closed" da policy;
   - `DELIVERY_UNKNOWN` sem reenvio;
   - o snapshot histórico das mensagens.
10. **O que falta para uma central unificada:**
    - escopo por **unidade**;
    - administração pelo **cliente** com permissões próprias;
    - **prova de posse** (OTP) separada do **consentimento**;
    - consentimento **por empresa e categoria**, com texto versionado e livro-razão;
    - **revogação pelo titular** sem depender do admin;
    - preferências de horário por destinatário;
    - categorias além do D-1 (fechamento operacional);
    - transporte oficial com templates.

## 4. Riscos identificados no modelo atual

| Risco | Evidência | Efeito |
|---|---|---|
| **Consentimento global por telefone** | `contatos_whatsapp.consentimento` (082) e 5 números em mais de uma empresa | autorizar o número na empresa A o torna "consentido" também na empresa B |
| **Verificação = consentimento = atestado do operador** | `validarWhatsApp` marca os três de uma vez | sem prova LGPD de consentimento livre, informado e inequívoco do titular (ônus da prova é do controlador) |
| **Sem texto/versão do consentimento** | não existe tabela ou coluna | impossível demonstrar *ao que* a pessoa consentiu |
| **Opt-out só por operador** | `registrarOptOutDestinatario` (origem `operador_painel_admin`); nenhum processamento de palavra-chave no inbox | o titular não consegue sair sozinho |
| **Transporte não oficial** | `whatsapp_conexoes.provider = baileys` | risco de banimento do número e de quebra de protocolo; histórico de travamento do sync offline (re-pareado em 25/09/2026) |
| Destinatário por empresa | ver §3.2 | o gerente de uma unidade recebe pendências das outras; a cota diária é compartilhada |

Nenhum desses riscos foi corrigido nesta missão (somente auditoria). O D-1 **não** foi alterado.
