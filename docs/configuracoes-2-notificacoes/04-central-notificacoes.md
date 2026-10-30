# 04 — Central de Notificações

## 1. Princípios

1. **Evoluir o que existe, sem pipeline paralelo.** A Central reaproveita:
   - `comunicacao_contatos_empresa` (destinatário),
   - `contatos_whatsapp` (telefone),
   - `comunicacao_categorias` e `comunicacao_destinatario_categorias`,
   - a fila `comunicacao_mensagens`,
   - a policy `avaliarEnvio`,
   - `comunicacao_reservar_envio`.
2. **Quatro coisas distintas** (doc 05): posse do número (OTP), consentimento do titular, autorização para ver dados da unidade e permissão administrativa para gerenciar destinatários.
3. **Escopo por unidade, sem quebrar o escopo por empresa.** Hoje todo destinatário recebe de todas as unidades da empresa. Isso vira o valor padrão explícito ("todas as unidades"), e o vínculo por unidade é um refinamento.
4. **D-1 intocado até a migração gradual** (doc 07).

## 2. Modelo de destinatário

```
contatos_whatsapp (telefone global: posse verificada, quando, como)          ← prova de POSSE
   └── comunicacao_contatos_empresa (destinatário da EMPRESA: nome, papel)    ← cadastro administrativo
          └── comunicacao_destinatario_escopos (NOVA: unidade | todas, categoria, preferências)
                                                                              ← o que recebe, de onde, quando
comunicacao_consentimentos (NOVA, append-only: titular × empresa × categoria × versão do texto)
                                                                              ← CONSENTIMENTO
```

- Um destinatário pode estar ligado a várias unidades, com categorias e horários próprios em cada uma (doc 06).
- O telefone é sempre exibido mascarado (`mascararTelefone`). O número completo só aparece para quem tem `notificacoes.gerenciar`, e apenas no formulário de edição (decisão D-4 do doc 10).

## 3. Estados do vínculo (por empresa; o escopo por unidade herda)

Os nomes foram validados contra o vocabulário real do sistema. Os bloqueios da policy (`OPT_OUT`, `NO_CONSENT`, `PHONE_NOT_VERIFIED`, `CATEGORIA_NAO_PERMITIDA`) continuam sendo a verdade da entrega. O estado da Central é uma **visão derivada**, calculada por função a partir dos dados de posse, consentimento e escopo, e **não** um enum gravado que possa divergir.

| Estado | Condição (derivada) | Recebe? |
|---|---|---|
| `PENDENTE_VERIFICACAO` | destinatário criado; posse do número não comprovada (sem OTP válido) | não |
| `VERIFICADO_SEM_CONSENTIMENTO` | posse comprovada; nenhum consentimento ativo nesta empresa | não |
| `ATIVO` | posse comprovada + consentimento ativo para ≥ 1 categoria + escopo ativo | sim, nas categorias consentidas **e** habilitadas no escopo |
| `SUSPENSO` | o administrador da unidade/empresa suspendeu (reversível; o consentimento é preservado) | não |
| `REVOGADO` | o titular revogou o consentimento (todas as categorias) **ou** registrou opt-out | não; só volta com novo consentimento **do titular** |
| `EXPIRADO` | convite ou desafio de verificação não concluído no prazo, **ou** verificação de posse mais velha que a política de revalidação (decisão D-6) | não |
| `LEGACY_ACTIVE` | destinatário que **já recebia o D-1** antes da migração (cadastro e autorização operacional anteriores, pelo Painel ADM). **Decisão aprovada em 30/10/2026** (doc 10, "Decisões tomadas") | **sim, só `pendencia_d1`**, exatamente como hoje, **sem prazo e sem OTP retroativo**. Nenhuma outra categoria sem passar pelo fluxo novo |

Transições:

```
(admin adiciona) → PENDENTE_VERIFICACAO → (titular confirma OTP) → VERIFICADO_SEM_CONSENTIMENTO
   → (titular aceita categorias) → ATIVO ⇄ SUSPENSO (admin)
   ATIVO → REVOGADO (titular: link de gestão, palavra-chave ou pedido registrado)
   PENDENTE_VERIFICACAO/convite → EXPIRADO (prazo) → (admin reenvia convite) → PENDENTE_VERIFICACAO

   (migração) → LEGACY_ACTIVE ⇄ SUSPENSO (admin)                  — continua recebendo o D-1 sem interrupção
   LEGACY_ACTIVE → REVOGADO (titular ou bloqueio — efeito imediato, inclusive mensagens já agendadas)
   LEGACY_ACTIVE → (adoção VOLUNTÁRIA: OTP + consentimento) → ATIVO   — o D-1 não para durante o processo
```

Regras do `LEGACY_ACTIVE`:
- Não tem prazo de expiração.
- Não exige OTP para continuar no D-1.
- Não ganha categoria nova automaticamente.
- Não aparece como "verificado por OTP" nem como "consentimento comprovado": a tela mostra **"Autorização operacional anterior (cadastro legado)"**, com a data do registro original.
- Para receber outra categoria (ex.: fechamento), o titular passa pelo fluxo novo, que pode ser oferecido pelo admin como convite. Concluído, o vínculo vira `ATIVO`.

## 4. Funcionalidades (usuário autorizado da unidade/empresa)

| Ação | Quem (proposta; decisão D-3) | Observação |
|---|---|---|
| Ver destinatários e estado | `notificacoes.ver` (org admin, unit manager, finance) | número mascarado |
| Ver pendência de unidade sem D-1 | `notificacoes.ver` | texto fixo: **"Nenhum destinatário configurado para o Dashboard iFood D-1"** (D-16) |
| Vincular destinatário **legado** a unidade nova (só D-1) | `notificacoes.gerenciar` | motivo obrigatório, auditado; não altera o snapshot; outras categorias só pelo fluxo OTP + consentimento (doc 06 §4.1) |
| Adicionar destinatário (nome, papel, WhatsApp, unidades, categorias pretendidas) | `notificacoes.gerenciar` | não ativa nada: gera **convite** ao titular |
| Reenviar convite / solicitar verificação | `notificacoes.gerenciar` | respeita intervalo e limites (doc 05) |
| Suspender / reativar na unidade | `notificacoes.gerenciar` | não mexe no consentimento |
| Remover vínculo com a unidade (ou com a empresa) | `notificacoes.gerenciar` | diálogo com consequência; histórico preservado |
| Definir categorias e horários por destinatário × unidade | `notificacoes.gerenciar` | restringe; **nunca amplia** além do consentimento do titular |
| Ver consentimentos ativos (categoria, versão do texto, data, origem) | `notificacoes.ver` | sem IP e sem dados técnicos |
| Revogar autorização **administrativa** | `notificacoes.gerenciar` | = suspender/remover. **Revogar o consentimento é ato do titular** (o admin pode registrar um pedido do titular, com motivo e auditoria) |
| Histórico de notificações por unidade/destinatário | `notificacoes.ver` | mensagens, status (enviada/entregue/lida/cancelada com motivo), sem conteúdo integral para quem não gerencia |

**Equipe Crescer (Painel Administrativo):**
- continua com a visão cross-tenant, o modo global, a conexão, os limites globais, o grupo interno e o apoio à adesão voluntária dos legados;
- não autoriza destinatário novo por atestado (decisão de 30/10/2026); pode suspender e registrar pedido de revogação do titular (D-7).

## 5. Categorias e preferências (resumo; detalhes no doc 07)

- **Catálogo** (`comunicacao_categorias`, existente) ganha os atributos: `grupo` (dashboard_ifood/operacao/financeiro/gestao), `exige_consentimento`, `estado` (`ATIVA`/`EM_BREVE`/`INTERNA`) e `fonte`.
- **Ativas na Etapa 4:** `pendencia_d1` (existente) e `fechamento_operacional_diario` (nova, ainda em simulação).
- Categorias futuras ficam `EM_BREVE` (visíveis, não selecionáveis) até haver fonte confiável e regra aprovada.
- **Preferências por destinatário × unidade × categoria:**
  - habilitada;
  - janela preferida;
  - silêncio;
  - agrupamento (§6);
  - para fechamento: "aviso de correção quando houver revisão" (sim/não).

## 6. Horários, limites e entrega

| Regra | Proposta |
|---|---|
| Fuso | da **unidade** (novo campo). Na ausência, o da empresa (`comunicacao_habilitacoes.timezone`), depois o da plataforma. A origem é registrada em cada mensagem (mesmo princípio do fechamento 2.0) |
| Janela comercial | global (`janelas`) ∩ janela da categoria ∩ janela preferida do destinatário. O reforço D-1 mantém a exceção 20–22 h atual |
| Silêncio | intervalo por destinatário. Mensagem que cair nele é **adiada** (não cancelada) até o fim, salvo se expirar antes (`expira_em`) |
| Agrupamento | fechamento: 1 mensagem por unidade/dia. Pendências D-1 de várias unidades para o mesmo destinatário: **opção** de resumo agrupado (decisão D-9; muda o D-1 e por isso fica para a fase de migração) |
| Limite por destinatário | o atual (`max_por_contato_por_dia = 3`) passa a contar por **categoria**, com teto global, para o fechamento não roubar a cota do D-1 (decisão D-9) |
| Limite por unidade | novo, configurável (padrão alto). Limite por empresa: o atual (`limite_diario_org`) |
| Prioridade | `critico > padrao > informativo` por categoria. O reservador consome a cota por prioridade |
| Deduplicação | chave por **fonte + versão + destinatário + propósito**. Fechamento: `wa:fech:{fechamento_id}:{contato_empresa_id}:inicial` (a versão já está no `fechamento_id`). Revisão: `…:{fechamento_id_revisado}:correcao` |
| Reenvio | o atual: retentável até 5; `DELIVERY_UNKNOWN` nunca reenvia; sem reenvio manual de `SENT` |
| Expiração | por categoria. D-1: o atual (corte 22:30). Fechamento: até 23:59 do dia seguinte à competência; depois disso não envia (fica no histórico como EXPIRADA) |
| Suspensão | por destinatário × unidade (Central), por empresa (`pausado_ate`, existente) e global (`modo`, existente) |
| Falha de entrega | persistente (N falhas PERMANENTE seguidas) → o destinatário vira `SUSPENSO` automaticamente com motivo "número inválido/bloqueado"; o admin é avisado na Central |
| Auditoria | ato administrativo → `auditoria` existente; ato do titular → `comunicacao_consentimentos` (livro-razão); envio → `comunicacao_mensagens` + `comunicacao_tentativas` |

**Fechamento diário:**
- O envio depende do **fechamento CONSOLIDADO** (ou REVISADO), nunca só do relógio. Quem dispara é o registro da versão (`operacional_fechamento_registrar` devolve `REGISTRADO`), e não um cron às 9 h.
- PRELIMINAR e INCOMPLETO **não** notificam, salvo uma categoria futura opcional "dados incompletos".
- A mesma versão nunca vai duas vezes ao mesmo destinatário (chave acima).
- Uma revisão gera notificação de **correção** só se o destinatário optou e a categoria permitir.
