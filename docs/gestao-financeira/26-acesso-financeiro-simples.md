# 26 — Acesso Financeiro simples (sem MFA nas concessões) e migration 126

Decisão do proprietário (2026-10-20): ativar o Dashboard Financeiro e dar acesso a pessoas deve ser uma tarefa simples,
feita numa única tela do Painel SuperAdmin. A exigência de MFA/AAL2 **só para as concessões financeiras** foi retirada.
Login, auditoria, RLS, isolamento por empresa/unidade e o bloqueio de impersonação continuam iguais.

## 1. O que o administrador faz
Painel SuperAdmin → **Acesso Financeiro**:
1. escolhe a **empresa** e a **unidade**;
2. liga ou desliga o **Financeiro** na unidade (chave);
3. para cada usuário com vínculo ativo, escolhe **Sem acesso / Visualização / Operador / Gestor**;
4. clica em **Salvar**. A tela mostra quantas alterações estão pendentes, permite **Descartar** e, depois de salvar,
   recarrega o estado que o servidor confirmou. Se algum usuário não puder ser gravado, o motivo aparece na linha dele.

| Opção na tela | Nível no banco | Pode |
|---|---|---|
| Sem acesso | — (concessão revogada) | não vê o setor Financeiro |
| Visualização | `leitura` | consultar os relatórios e telas do Financeiro |
| Operador | `operador` | consultar, criar e editar lançamentos |
| Gestor | `gestor` | tudo do operador + conciliar, cancelar lançamentos, configurar o plano de contas e fechar períodos |

Usuários com concessão ativa mas **sem vínculo** com a unidade/empresa aparecem marcados "sem vínculo": a tela mostra o
nível atual e só oferece removê-lo.

## 2. API (só SuperAdmin; montada em `/api/v1/plataforma/gestao-financeira/concessoes`)
| Rota | O que faz |
|---|---|
| `GET /unidades/:unidadeId/acessos` | unidade, Financeiro ligado/desligado, se a gravação está liberada, usuários e nível atual |
| `PUT /unidades/:unidadeId/acessos` | corpo `{ habilitado: boolean, acessos: [{ perfilId, nivel: "leitura" \| "operador" \| "gestor" \| null }] }` |

O corpo **não** aceita concedente, empresa nem motivo: o concedente é sempre a sessão (`req.user`), a empresa vem da
unidade no banco e o motivo é gerado ("Acesso gestor definido na gestão de acessos por <e-mail do SuperAdmin>."). O servidor:
- recusa tudo com 403 `CONCESSOES_BLOQUEADAS` se a chave de rollout `FINANCEIRO_CONCESSOES_HABILITADAS` estiver desligada;
- valida o pedido inteiro antes de escrever (níveis conhecidos, sem perfis repetidos, no máximo 500 itens);
- recusa conceder/alterar para quem não tem vínculo ativo (`PERFIL_NAO_ELEGIVEL`); remover é sempre permitido;
- ao **ligar**: liga o módulo na empresa (se faltar) e na unidade; ao **desligar**: mexe só na unidade; em ambos
  encerra as sessões abertas da unidade para os menus serem recalculados;
- grava cada concessão/alteração/revogação com auditoria própria (`financeiro.concessao_concedida`,
  `financeiro.concessao_alterada`, `financeiro.concessao_revogada`) além da trilha do gatilho `gfc_auditar` no banco;
- devolve `{ modulo, concedidos, alterados, revogados, inalterados, falhas, estado }` — a tela só mostra o que veio daqui.

As rotas antigas (`POST /concessoes`, `POST /:id/revogar`, listagem e auditoria) continuam existindo.

## 3. Segurança — o que mudou e o que não mudou
| Regra | Antes | Agora |
|---|---|---|
| MFA/AAL2 recente para conceder/revogar | exigido | **retirado** (só nas concessões financeiras) |
| Quem concede | SuperAdmin | SuperAdmin (sem mudança; `plataformaRouter`) |
| Autoconcessão | proibida para todos | proibida, **exceto para o SuperAdmin ativo da plataforma** (backend e banco, migration 126) |
| Vínculo ativo, perfil ativo, unidade da empresa, 1 concessão ativa por perfil+unidade, identidade imutável | gatilho `gfc_validar` | igual |
| Impersonação / `display_operator` no setor Financeiro | bloqueados | igual |
| Gate do setor (módulo na empresa + na unidade + concessão vigente) | igual | igual |
| Chave `FINANCEIRO_CONCESSOES_HABILITADAS` | trava geral de escrita | só chave de rollout (desligada = nada é gravado) |

"Nenhum usuário pode elevar o próprio privilégio": a tela é exclusiva do SuperAdmin e o banco recusa a autoconcessão de
qualquer conta que não esteja ativa em `plataforma_admins`. O SuperAdmin já é a autoridade máxima da plataforma; a
concessão própria fica auditada como qualquer outra. `backend/src/shared/mfaRecente.js` continua existindo porque o
`auth.js` ainda carimba o segundo fator na sessão; as concessões não o usam mais.

## 4. Migration 126
- `database/migrations/126_financeiro_autoconcessao_superadmin.sql`: troca só o corpo de `public.gfc_validar()`
  (regra de autoconcessão). Idempotente; não altera dados, grants, RLS nem outros gatilhos.
- `database/migrations/126_rollback.sql`: volta exatamente à função da 120.
- Testada em PostgreSQL local descartável (`backend/testes-financeiro-pg/50_autoconcessao_126.test.sql`, 7 casos;
  `run.sh` aplica duas vezes, testa, aplica o rollback, confirma que a proibição voltou e reaplica).

**Sem a 126 em produção**, o código novo funciona para dar acesso a outras pessoas, mas o SuperAdmin não consegue dar
acesso a si mesmo (o banco recusa e a tela mostra a falha na linha dele).

## 5. Publicação (cada passo só com autorização explícita)
1. **Aplicar a 126 em produção** (operador, no próprio terminal; conexão só em `PROD_CONN`, nunca no chat):
   ```
   node backend/testes-seguros/producao/prod-migrar-126.mjs preflight
   PROD_IDENTIDADE=<impresso> PROD_AUTORIZO=SIM PROD_BACKUP_CONFIRMADO=SIM node backend/testes-seguros/producao/prod-migrar-126.mjs aplicar
   PROD_IDENTIDADE=<impresso> node backend/testes-seguros/producao/prod-migrar-126.mjs verificar
   ```
   O script confere o sha256 da 126, recusa projeto de testes e porta 6543, e só aceita "OK" se a regra nova estiver
   ativa e nada além da função tiver mudado. Rollback: `126_rollback.sql`.
2. **Merge do PR** (o merge na `main` é o deploy no Render — ver doc 25 §1).
3. Com `FINANCEIRO_CONCESSOES_HABILITADAS` ligada no Render, o SuperAdmin abre **Acesso Financeiro**, escolhe empresa e
   unidade, liga o Financeiro, define o próprio nível e o das pessoas e salva. A conta do SuperAdmin precisa ter
   **vínculo ativo** com a empresa ou a unidade (Painel → Usuários) para aparecer na lista como elegível.

## 6. Testes
| Onde | Comando | Resultado nesta branch |
|---|---|---|
| Domínio e rotas | `node --test backend/test/gestao-financeira-concessoes.test.js backend/test/gestao-financeira-acessos-simples.test.js` (env falso) | 30/30 |
| Lista de migrations | `backend/test/comunicacao-arquitetura-agendamento.test.js`, `backend/test/ifood-migration-103.test.js` | 43/43 |
| Banco (PG descartável) | `FIN_PG_DESCARTAVEL=1 FIN_PG_PORT=54329 bash backend/testes-financeiro-pg/run.sh` | OK, 126 7/7 + rollback |
| Modelo da tela | `node --test frontend/test/adminAcessoFinanceiro.test.js` | 10/10 (frontend todo: 1549/1549) |
| Navegação (Chrome real, backend falso) | `node backend/testes-seguros/qa-visual/servidor-qa.mjs 4195` + `QA_PORTA=4195 QA_MODULOS=<pasta com playwright-core> node backend/testes-seguros/qa-visual/qa-admin.mjs` | 22/22 (desktop e celular 390px) |
