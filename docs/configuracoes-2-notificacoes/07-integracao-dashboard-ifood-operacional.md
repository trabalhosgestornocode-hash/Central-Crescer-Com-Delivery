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
>
> **D-16 APROVADA (30/10/2026) — escopo de unidades dos legados:**
> - A lista de unidades abrangidas é **congelada** num snapshot imutável por destinatário × empresa × unidade, com data e rastreabilidade.
> - Unidades criadas depois **não herdam** legados e aparecem como pendência "Nenhum destinatário configurado para o Dashboard iFood D-1".
> - O admin autorizado pode vincular um legado a uma unidade nova **só para o D-1**, com auditoria.
> - Nenhuma outra categoria é automática.
> - O comportamento anterior é preservado até a nova seleção ser homologada e ativada.
> - **"Data da migração" = ativação da nova seleção (M3)**, para que o snapshot coincida exatamente com o alcance do comportamento anterior. Assim a equivalência é exata (regra 10), sem lacuna entre a regra 3 e a regra 12.

| Fase | O que muda | O que NÃO muda | Reversão |
|---|---|---|---|
| **M0 — Fundação** (Etapa 2/3) | **só as tabelas novas**, vazias de legado. Nenhum backfill de escopo ainda (D-16: o snapshot é feito na ativação, M3). **Nenhuma** linha no livro-razão de consentimento; `contatos_whatsapp` e `comunicacao_destinatario_categorias` intocados | `comunicacao_resolver_destinatarios` continua lendo as tabelas antigas; envio idêntico, **inclusive para unidade criada neste período** (regra 12: comportamento anterior até a ativação) | apagar as tabelas novas (sem efeito no envio) |
| **M1 — Central visível** | o cliente vê os destinatários legados lidos das tabelas antigas, com o selo "Autorização operacional anterior — recebe o D-1 de todas as unidades da empresa (configuração anterior)", além de histórico e estado. Destinatário **novo** entra **só** pelo fluxo convite → OTP → consentimento → categorias. O Painel ADM deixa de "autorizar" destinatários novos por atestado | os legados continuam recebendo o D-1 exatamente como hoje | desligar a Central por flag |
| **M2 — Adesão voluntária** (contínua, sem prazo) | o admin pode **oferecer** o fluxo novo a um legado (ex.: para receber o fechamento); o titular conclui OTP + consentimento → `ATIVO` com evidência real; durante o processo o D-1 segue | o legado que não aderir continua `LEGACY_ACTIVE` indefinidamente | — |
| **M3 — Ativação da nova seleção = "data da migração" do D-16** (só depois de homologada e com autorização específica) | numa **única transação** (`comunicacao_ativar_selecao_por_escopo`):<br>1. grava `comunicacao_legado_snapshot`: para cada destinatário ativo com `pendencia_d1` habilitada, uma linha por **unidade ativa da empresa naquele instante** (exatamente o alcance do comportamento anterior);<br>2. cria os escopos `LEGACY_ACTIVE` correspondentes (`origem_vinculo = SNAPSHOT_MIGRACAO`, `snapshot_id`);<br>3. liga a flag.<br>A partir daí `comunicacao_resolver_destinatarios` lê os escopos: `LEGACY_ACTIVE` vale **só** para `pendencia_d1` nas unidades do snapshot e nas incluídas explicitamente; `ATIVO` vale para as categorias consentidas e autorizadas | o pipeline (fila, policy, reservador, horários, reforço, chaves) é o mesmo; a prova de regressão (Etapa 5) precede a ativação | desligar a flag (volta ao comportamento anterior; snapshot e escopos permanecem como registro), ou recriar a função anterior (corpo guardado no rollback, padrão 100/104) |
| **M3+ — Unidades novas** | unidade criada depois da ativação **não herda** legado; aparece na Central como "Nenhum destinatário configurado para o Dashboard iFood D-1"; o admin pode vincular explicitamente um legado só para o D-1, com motivo e auditoria (doc 06 §4.1) | o D-1 das unidades do snapshot continua idêntico | remover o vínculo (auditado) |

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

**Cenários obrigatórios (D-16, regra 11):**
- empresa com **1 unidade**;
- empresa com **várias unidades** (6, como na produção);
- unidade criada **antes** da ativação: entra no snapshot, equivalência exata;
- unidade criada **depois** da ativação: não herda, gera a pendência e só recebe após a inclusão explícita auditada;
- unidade **desativada** ou **de teste** antes da ativação: fica fora do snapshot, exatamente como o comportamento anterior.

**Universo do snapshot** = o mesmo do monitor D-1, ou seja, a função que monta o universo monitorado em `backend/src/modules/administrativo/administrativo.repo.js:69-123`:
- `unidades.ativo = true`;
- organização com `status = 'ativa'`;
- sem `eh_teste`.

A ativação reutiliza essa função, sem critério paralelo, e a prova de equivalência compara contra ela. Uma unidade **reativada** depois da ativação é tratada como unidade nova: não herda, gera pendência e exige vínculo explícito.

Comparação **antes × depois** de cada migration nova e, sobretudo, **imediatamente antes × imediatamente depois da ativação M3** (mesmo relógio, mesmas fixtures):

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
8. O snapshot tem exatamente uma linha por destinatário × unidade abrangida, é imutável (UPDATE e DELETE recusados, inclusive para o `service_role`), e reexecutar a ativação é idempotente (não duplica linhas).
9. Uma revogação ou bloqueio registrado **depois** do agendamento e **antes** do envio cancela a mensagem já enfileirada no JIT, para legado e para destinatário novo, com provider = 0.
10. Toda inclusão ou remoção de vínculo gera auditoria. Tentar vincular legado a outra categoria ou a unidade de outra empresa é recusado.

Nenhuma alteração na base de produção nem no gateway é feita sem autorização específica.

### 1.2 Ativação M3 — garantias (D-16, momento do congelamento **APROVADO** em 30/10/2026)

A ativação é **uma** chamada da RPC `comunicacao_ativar_selecao_por_escopo(p_migracao_id, p_universo, p_ator)`, disparada só pelo Painel ADM, com confirmação explícita, MFA quando exigido e **autorização específica para cada ambiente**. Nunca é executada por migration, deploy ou agendador.

| Garantia exigida | Como |
|---|---|
| **Captura = unidades abrangidas pelo monitor atual** | o backend monta `p_universo` com a **mesma função** do monitor D-1 (`administrativo.repo.js:69-123`, sem critério paralelo) e envia `{unidade_id, organizacao_id}` + hash. A RPC confere no banco que cada unidade existe, está ativa, pertence à empresa e não é de teste; qualquer divergência aborta |
| **Atômica com a mudança da seleção** | numa só transação: snapshot (`comunicacao_legado_snapshot`) → escopos `LEGACY_ACTIVE` (`origem_vinculo = SNAPSHOT_MIGRACAO`) → flag `comunicacao_configuracoes.selecao_por_escopo = {ligada, migracao_id, ativada_em, ator}` → auditoria `NOTIFICACAO_SELECAO_ATIVADA` (contagens + hash do snapshot) |
| **O D-1 nunca observa estado intermediário** | (1) `comunicacao_resolver_destinatarios` vira **um único comando SQL** que lê a flag e escolhe o ramo (antigo × escopos) no mesmo snapshot MVCC; (2) as RPCs de agendamento do D-1 tomam `pg_advisory_xact_lock_shared(K)`, e a ativação toma `pg_advisory_xact_lock(K)` exclusivo: nenhum agendamento roda durante a ativação, e todo agendamento vê ou tudo antigo ou tudo novo |
| **Equivalência verificada dentro da própria transação** | antes do `COMMIT`, a RPC compara, para **todas** as empresas, a resolução pelo ramo antigo com a resolução pelo ramo novo (`contato_empresa_id`, `elegivel`, `motivo`). Qualquer diferença levanta exceção → `ROLLBACK` |
| **Idempotente** | flag já ligada com o mesmo `migracao_id` → devolve `JA_ATIVADA`, sem efeito. Outro `migracao_id` com a flag ligada → recusa. `UNIQUE (migracao_id, contato_empresa_id, unidade_id)` no snapshot |
| **Falha segura** | qualquer erro (lock_timeout de 5 s, divergência, constraint) desfaz tudo: a flag continua desligada e o D-1 segue pelo comportamento anterior. Nada fica pela metade |
| **Snapshot imutável** | trigger recusa UPDATE/DELETE (inclusive `service_role`); fora do remapeamento da transferência (doc 06 §4) |
| **Alterações posteriores em eventos separados** | inclusão ou remoção de vínculo, suspensão, revogação: escopo + `plataforma_auditoria` (doc 06 §3.4). O snapshot nunca é tocado |
| **Novas unidades não herdam** | depois da ativação, a resolução só lê escopos com `unidade_id` explícito (doc 06 §4.1) |
| **Revogação também em mensagens enfileiradas** | o JIT revalida opt-out, consentimento e escopo antes de cada envio (policy fail-closed). Revogar ou suspender após o agendamento cancela no próximo claim, com provider = 0 (prova 9 do §1.1) |
| **Reversão** | desligar a flag (outra chamada auditada) devolve o comportamento anterior. Snapshot, escopos e auditoria permanecem como registro histórico |

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
