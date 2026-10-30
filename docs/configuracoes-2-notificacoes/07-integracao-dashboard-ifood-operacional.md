# 07 — Integração com o Dashboard iFood (D-1) e o Dashboard Operacional 2.0

## 1. Dashboard iFood: migração gradual e reversível

Hoje 38 empresas recebem o D-1 automaticamente, com 41 destinatários "VALIDADO" por atestado do operador. **Nada pode parar.**

> **Decisão aprovada (30/10/2026) — preservação dos destinatários existentes:**
> - Todos os destinatários ativos são migrados como **`LEGACY_ACTIVE`**: sem exclusão, desativação ou interrupção, e **sem OTP retroativo nem prazo**.
> - Número, vínculos, preferências e estado de envio são preservados.
> - Nenhuma evidência de OTP, aceite ou versão de consentimento é registrada onde não existe.
> - Categorias novas **nunca** são autorizadas automaticamente.
> - Novos destinatários usam o fluxo novo; os legados podem aderir voluntariamente sem parar de receber.
> - Revogações e bloqueios valem na hora, para todos.

| Fase | O que muda | O que NÃO muda | Reversão |
|---|---|---|---|
| **M0 — Fundação** (Etapa 2/3) | tabelas novas. Backfill: cada destinatário atual com `pendencia_d1` habilitada em `comunicacao_destinatario_categorias` ganha escopo `origem_autorizacao = LEGACY_ACTIVE`, `categoria = pendencia_d1`, com o **mesmo alcance de unidades de hoje** (ver D-16). **Nenhuma** linha no livro-razão de consentimento; `contatos_whatsapp` intocado | `comunicacao_resolver_destinatarios` continua lendo as tabelas antigas; envio idêntico | apagar as tabelas novas (sem efeito no envio) |
| **M1 — Central visível** | o cliente vê destinatários (legados com o selo "Autorização operacional anterior"), histórico e estado; destinatário **novo** entra **só** pelo fluxo convite → OTP → consentimento → categorias. O Painel ADM deixa de "autorizar" destinatários novos por atestado | os legados continuam recebendo o D-1 exatamente como hoje | desligar a Central por flag |
| **M2 — Adesão voluntária** (contínua, sem prazo) | o admin pode **oferecer** o fluxo novo a um legado (ex.: para receber o fechamento); o titular conclui OTP + consentimento → `ATIVO` com evidência real; durante o processo o D-1 segue | o legado que não aderir continua `LEGACY_ACTIVE` indefinidamente | — |
| **M3 — Resolução pelos escopos** (flag, desligada por padrão) | `comunicacao_resolver_destinatarios` passa a ler os escopos: `LEGACY_ACTIVE` vale **só** para `pendencia_d1`; `ATIVO` vale para as categorias consentidas e autorizadas pelo admin | o pipeline (fila, policy, reservador, horários, reforço, chaves) é o mesmo; a prova de regressão (Etapa 5) precede a ativação da flag | desligar a flag, ou recriar a função anterior (corpo guardado no rollback, padrão 100/104) |

Regras de compatibilidade:
- **Horários:** o D-1 continua com a janela global e o reforço 20–22 h. A janela do destinatário só **restringe** e só vale para quem a configurar. Os legados não têm janela própria, então nada muda para eles.
- **Histórico:** `comunicacao_mensagens` sem alteração. A Central do cliente lê por empresa/unidade.
- **Filas, reenvio e limites:** inalterados para o D-1 (a decisão D-9 só afeta categorias novas).
- **Legado ≠ consentimento para categoria nova:** garantido no banco (`CHECK`: `LEGACY_ACTIVE` só com `pendencia_d1`) e na resolução, com teste.
- **Revogação e bloqueio de legado:** opt-out, suspensão ou revogação têm efeito imediato. A policy já bloqueia no JIT, inclusive mensagens agendadas e o reforço.

### 1.1 Prova de regressão obrigatória (D-1 inalterado)

Rodada em Postgres descartável com a cadeia real da `main` + fixtures sintéticas que reproduzem a forma da produção:
- 39 empresas, 1 delas com 6 unidades;
- 41 destinatários (principal/secundário/operacional);
- 5 números compartilhados entre empresas;
- habilitações com 3 fusos;
- opt-out e pausa.

Comparação **antes × depois** de cada migration nova e com a flag M3 desligada **e** ligada:

1. `comunicacao_resolver_destinatarios(org, 'dashboard_ifood_d1')` devolve **o mesmo conjunto** (`contato_empresa_id`, `elegivel`, `motivo`) para todas as empresas.
2. Um ciclo completo do worker (`executarCiclo` com relógio fixo, transporte fake), em dia útil, sábado, domingo, prazo do reforço e aviso tardio, gera **as mesmas mensagens**:
   - destinatários;
   - `idempotency_key`;
   - `tipo`;
   - `conteudo` (byte a byte);
   - `disponivel_em`/`expira_em`;
   - `metadados.proposito`.
3. Mesmas decisões da policy (`avaliarEnvio`) e da reserva (`comunicacao_reservar_envio`): cotas, cooldown e limites.
4. Os legados **não** recebem nenhuma outra categoria; tentar habilitar o fechamento para um legado é recusado pelo banco e pela API.
5. Opt-out / revogação / suspensão de um legado bloqueiam a mensagem agendada **no mesmo ciclo**.
6. Nenhuma linha `CONCEDIDO` e nenhum desafio OTP são criados para legados pela migração. Os campos globais de `contatos_whatsapp` ficam idênticos (hash da tabela antes/depois).
7. Rollback de cada migration devolve o estado anterior idêntico.

Nenhuma alteração na base de produção nem no gateway é feita sem autorização específica.

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
