# 07 — Integração com o Dashboard iFood (D-1) e o Dashboard Operacional 2.0

## 1. Dashboard iFood: migração gradual e reversível

Hoje 38 empresas recebem o D-1 automaticamente, com 41 destinatários "VALIDADO" por atestado do operador. **Nada pode parar.**

| Fase | O que muda | O que NÃO muda | Reversão |
|---|---|---|---|
| **M0 — Fundação** (com a Etapa 2/3) | tabelas novas; backfill: cada destinatário atual ganha escopo `unidade = todas`, `categoria = pendencia_d1` (copiado de `comunicacao_destinatario_categorias`) e uma linha `LEGADO_ATESTADO` no livro-razão (origem `migracao_legado`, data = `autorizacao_registrada_em`) | `comunicacao_resolver_destinatarios` continua lendo as tabelas antigas; envio idêntico | apagar as tabelas novas (sem efeito no envio) |
| **M1 — Central visível** | cliente vê destinatários, histórico e estado (`LEGADO_A_REGULARIZAR`); pode adicionar destinatário novo, que entra **pelo fluxo OTP + consentimento** | os legados continuam recebendo D-1; admin da Crescer mantém o Painel ADM | desligar a Central por flag |
| **M2 — Regularização** | convite de regularização para cada legado (o admin da empresa ou a equipe envia); quem conclui vira `ATIVO` com consentimento real | **o atestado legado só vale para `pendencia_d1`**; nunca é estendido a categoria nova | — |
| **M3 — Resolução pelos escopos** | `comunicacao_resolver_destinatarios` passa a ler escopos + consentimento vigente; o legado ainda conta como consentimento **só para `pendencia_d1`** até o prazo | o pipeline (fila, policy, reservador, horários, reforço) é o mesmo | recriar a função anterior (corpo guardado no rollback, padrão 100/104) |
| **M4 — Fim do prazo** (data a decidir, D-2) | `LEGADO_ATESTADO` deixa de valer; quem não regularizou para de receber e aparece como `VERIFICADO_SEM_CONSENTIMENTO` (ou `PENDENTE_VERIFICACAO`) com alerta para o admin | — | prorrogar o prazo (config) |

Regras de compatibilidade:
- **Horários:** o D-1 continua com a janela global e o reforço 20–22 h. A janela do destinatário só **restringe**. Na fase M3, o silêncio do destinatário adia o aviso normal, mas não o reforço (o reforço já tem corte 22:30).
- **Histórico:** `comunicacao_mensagens` sem alteração. A Central do cliente lê por empresa/unidade.
- **Filas, reenvio e limites:** inalterados até a decisão D-9 (cota por categoria).
- **Cadastros antigos ≠ consentimento para categoria nova:** garantido pela regra "legado só para `pendencia_d1`", e testado.

## 2. Dashboard Operacional 2.0: fechamento diário

Reaproveitamento, sem duplicar cálculo:

| Peça existente | Uso |
|---|---|
| `operacional_fechamentos` (versão imutável, `hash_conteudo`, status) | **gatilho e conteúdo**. A mensagem é gerada **da versão armazenada**, nunca recalculada |
| `checklistOperacional.whatsapp.js` (`montarMensagem`, `validarMensagem` com proibição de PII) | **mesmo texto** da prévia e da simulação. Mesmos números da tela, do PDF e do Excel (provado no teste de navegador do PR #54) |
| `previaWhatsapp` / `simularWhatsapp` (operacional.service) | continuam como "Prévia" e "Simular" na tela do fechamento |
| `operacional_mensagens_simuladas` | histórico de simulações (`transporte = noop`, CHECK no banco) |
| Isolamento (repositório filtra organização + unidade; trigger de tenant) | o envio resolve destinatários por **escopo da unidade do fechamento** |

Fluxo proposto (Etapa 4; **o transporte continua simulado** até a Etapa 6):

```
gerarFechamento → operacional_fechamento_registrar → REGISTRADO (CONSOLIDADO | REVISADO)
  → notificacoes.enfileirarFechamento(fechamento_id)          [mesma transação lógica; idempotente]
       resolve escopos: unidade do fechamento, categoria fechamento_operacional_diario, ATIVO
       para cada destinatário: chave wa:fech:{fechamento_id}:{contato_empresa_id}:{inicial|correcao}
       REVISADO → só quem marcou "notificar correção" (texto com "Correção da versão N")
  → comunicacao_mensagens (tipo fechamento_operacional_diario, alerta_id null, expira_em = D+1 23:59 no fuso da unidade)
  → pipeline existente (claim → policy → reservar_envio → transporte)
       transporte da categoria = 'noop' enquanto a categoria estiver em simulação → status SIMULATED, provider = 0
```

- **Disparo pela consolidação, não pelo relógio:**
  - o agendador do Dashboard 2.0 (hoje travado por duas variáveis) gera o fechamento quando o dia é consolidável;
  - a notificação nasce do `REGISTRADO`;
  - PRELIMINAR e INCOMPLETO não notificam.
- **Sem duplicidade:** a chave inclui `fechamento_id` (que identifica a versão) e o destinatário, e o índice único existente (`comunicacao_mensagens_idempotency_unica`) garante.
- **Policy:** `pendenciaAindaExiste` é específico de alerta; para fechamento, o JIT verifica que a versão ainda é a **última** da competência. Se uma revisão chegou antes do envio, a inicial é cancelada (`CANCELADO_VERSAO_SUPERADA`) e só a correção sai.
- **Template oficial (Etapa 6):** a mensagem de 900+ caracteres com formatação vira um **template utility** com variáveis (números principais) + rodapé "Responda MENU para o detalhe" (decisão D-12). O texto integral não pode ir como template livre fora da janela de 24 h (doc 08).

## 3. Futuras fontes

Cada nova categoria precisa de quatro coisas:
1. a fonte confiável que a produz;
2. a regra aprovada (quando, para quem, com que frequência);
3. o texto do consentimento (nova versão do termo);
4. a linha no catálogo com estado `ATIVA`.

**Candidatas (todas `EM_BREVE`):**
- resumo semanal (do fechamento);
- cancelamentos relevantes;
- atrasos operacionais;
- disputas expiradas (há dados na camada analítica);
- falha de integração (iFood desconectado, poller parado);
- Financeiro (divergência, conciliação, repasses);
- Gestão (metas, diagnósticos, planos).

**Notificações internas da equipe técnica** (falha de integração, poller parado) vão ao **grupo interno** (109) e **não** exigem consentimento de cliente. Elas nunca usam números de cliente.
