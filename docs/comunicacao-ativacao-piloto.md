# Comunicação — alavancas de envio no Painel Administrativo (Checkpoint H.4-B.1)

Habilitar a organização e ligar o modo global só existem como **ações do Painel Administrativo**, com ator humano
autenticado, confirmação explícita para LIGAR e auditoria. Nada de SQL direto nem `service_role` como ator.

| Ação | Rota | Regras |
|---|---|---|
| Ver estado | `GET /administrativo/comunicacao/ativacao` | modo, prova do piloto no `process.env` real (só `ativo` + `quantidadeDestinos`), empresas habilitadas, pendências elegíveis, gateway. Nunca telefone/segredo. |
| Habilitar/desabilitar empresa | `PUT …/organizacoes/:id/habilitacao` `{habilitado, confirmacaoExplicita}` | `false`: sempre permitido. `true`: confirmação + piloto ativo + **exatamente 1 destino** na allowlist + destinatário da empresa nela + (RPC atômica, migration 093) modo `DISABLED`, nenhuma outra empresa habilitada, timezone/tipo/destinatário ok, destinatário consentido/verificado/sem opt-out. |
| Ligar/desligar modo | `PUT /administrativo/comunicacao/modo` `{modo, confirmacaoExplicita}` | só `DISABLED`/`NORMAL`. `DISABLED`: sempre permitido. `NORMAL`: confirmação + piloto ativo + 1 destino + **exatamente 1** empresa habilitada + destinatário dela na allowlist + Gateway conectado. |

Auditoria: `COMUNICACAO_ORGANIZACAO_HABILITADA|DESABILITADA`, `COMUNICACAO_MODO_ATIVADO|DESATIVADO` (ator, e-mail, perfil,
organização; nunca telefone). `definirModo` continua gravando `CONFIG_ALTERADA`.

Guarda estática: o único arquivo fora de `comunicacao.config.js` que importa/chama `definirModo` é
`administrativo.comunicacao.service.js` (teste em `administrativo-comunicacao-ativacao.test.js`).

Efeito colateral já existente e desejável: salvar a configuração da empresa (`PUT …/configuracao`) grava
`habilitado=false` — editar uma empresa habilitada a **desabilita**.

Migration 093: `comunicacao_habilitar_organizacao_piloto(uuid, uuid)` — `SECURITY INVOKER`, só `service_role`, serializada
por advisory lock. Rollback: `093_rollback.sql` (não altera dados).
