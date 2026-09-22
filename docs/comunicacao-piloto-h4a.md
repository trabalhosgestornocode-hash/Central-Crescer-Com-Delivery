# Preparação do primeiro piloto WhatsApp — Checkpoint H.4-A

Infraestrutura de segurança e visibilidade para a primeira ativação
controlada do canal — **sem enviar nenhuma mensagem**. `modo` continua
`DISABLED`, nenhuma organização está `habilitado=true`, nenhuma mudança de
produção foi feita neste checkpoint.

## Objetivo desta fase

Preparar UMA organização (e só uma) para o piloto, com todas as camadas de
proteção prontas e testadas, sem ligar nada de fato. A decisão de QUAL
organização e a confirmação de consentimento são do usuário, não da
implementação — ver `docs/comunicacao-painel-administrativo-h3a.md` e a
seção "Organização candidata" abaixo.

## Organização candidata (achado da auditoria, não uma decisão técnica)

Auditoria read-only nas 48 organizações de produção: todas têm perfis
elegíveis de sobra (contas de demonstração/seed), mas **só uma** tinha
qualquer telefone configurado — "Grupo Jailton e Vanessa"
(`00000000-0000-0000-0000-000000000001`), efeito colateral do QA manual do
H.3-B.1. `consentimento=false` nesse registro na auditoria original;
requer confirmação explícita do usuário antes de qualquer mudança real de
produção (H.4-A não altera banco de produção).

## Allowlist do piloto (itens 4-8) — `comunicacao.piloto.js`

Camada de defesa em profundidade, **opt-in**, aplicada como o **último**
check de `comunicacao.policy.js#avaliarEnvio` — depois de TODOS os outros
gates (modo, contato, consentimento, opt-out, vínculo, empresa habilitada,
tipo permitido, pausa, pendência, duplicidade, cooldown, horário,
rate-limit, provider). Nunca substitui nenhum deles.

```
COMUNICACAO_PILOTO_ENABLED=true|ausente          (mesmo padrão de COMUNICACAO_WORKER_ENABLED — só "true" liga)
COMUNICACAO_PILOTO_TELEFONES_E164=+55...,+55...  (lista separada por vírgula)
```

- **Flag desligada (padrão, estado atual)**: a allowlist não interfere em
  NADA — `telefoneAutorizadoNoPiloto()` sempre devolve `true`. É assim que a
  camada deixa de existir depois que o piloto terminar, sem virar uma
  restrição permanente.
- **Flag ligada**: lista ausente/vazia/malformada → **ninguém** passa
  (fail-closed); telefone fora da lista → bloqueado
  (`MOTIVOS_BLOQUEIO.FORA_DA_ALLOWLIST_PILOTO`, motivo **PERMANENTE**, não
  transitório — corrigir a allowlist é decisão humana); telefone na lista →
  passa (sujeito a todos os outros gates, que continuam valendo).
- Uma entrada malformada na allowlist invalida a **lista inteira** (nunca
  aceita parcialmente); loga um aviso sem nunca ecoar o valor bruto.
- Nunca loga o E.164 completo — reaproveita `mascararTelefone()` de
  `comunicacao.contatos.repo.js` (nenhuma segunda função de máscara).

**Compatibilidade retroativa deliberada**: `avaliarEnvio` só bloqueia por
`telefoneNaAllowlistPiloto === false` (explícito). Um snapshot que nem
conhece o campo (todo o histórico de testes/chamadores anteriores ao H.4-A)
continua passando — o campo ausente NÃO bloqueia, ao contrário do padrão
"ausente bloqueia" do resto do Policy Engine, de propósito documentado no
próprio código.

## Pré-visualização (itens 15-18) — `preverMensagem()`

`GET /administrativo/comunicacao/organizacoes/:id/preview-mensagem?unidadeId=`
— somente leitura, nunca cria `comunicacao_mensagens`/`comunicacao_tentativas`,
nunca chama o provider, nunca audita como envio. Usa a MESMA função de
template do pipeline real (`comunicacao.template.js#formatarMensagemPendencia`,
extraída de `comunicacao.alertas.service.js` para este arquivo justamente
para poder ser reaproveitada sem violar o teste arquitetural que impede
qualquer import do pipeline de orquestração fora do worker dedicado — texto
puro não é orquestração). Sem pendência real disponível para a organização:
`{disponivel: false}`, nunca inventa dado.

**Texto exato do template** (idêntico ao que seria enviado de verdade —
revisado no Checkpoint H.4-A.1, item 2: a versão anterior insinuava que o
Agente Crescer já podia continuar a conversa, etapa ainda não habilitada;
o nome da empresa também saiu do texto, mantido só no nome da unidade):
```
Olá! Identificamos que a unidade {unidadeNome} possui um lançamento
pendente no Crescer com Delivery há {N dia(s)}, desde DD/MM/AAAA. Por
favor, acesse o sistema para verificar e regularizar a pendência. —
Crescer com Delivery
```
Sem `pendenciaMaisAntiga`, a cláusula "desde ..." é omitida inteira (nunca
uma vírgula solta) — mesmo comportamento defensivo de antes, só com a
pontuação atualizada.
Tipo único liberado nesta fase: `dashboard_ifood_d1` (pendência de
lançamento iFood D-1) — já é o único tipo existente no enum `TIPOS_ALERTA`
(fase 1 do módulo), então "escolher só um tipo" já está satisfeito pela
própria arquitetura atual, não por uma nova restrição.

## Revalidação just-in-time (itens 19-20) — já existe, confirmado

`processarJobReivindicado` (`comunicacao.alertas.service.js`) já revalida a
pendência (`verificarPendenciaAindaExiste`) **antes** de reservar o envio —
se a condição de negócio já não existe, cancela com `PENDENCIA_RESOLVIDA`
sem tocar o provider. Cenário "09:00 detectada, 09:20 resolvida, 09:30
enviaria": cancela, não envia. Nenhum código novo foi necessário; comportamento
pré-existente, não alterado.

## Concorrência / rolling deploy (itens 21-26) — já provado por testes existentes

Auditados (não duplicados):
- **Detecção** (item 22): `comunicacao_alertas_chave_unica` (UNIQUE NULLS NOT
  DISTINCT) — provado em `comunicacao-dedup-constraint.test.js` (linhas
  concorrentes com a mesma chave lógica são recusadas pelo banco).
- **Agendamento** (item 23): `comunicacao-agendamento-atomico.test.js` —
  "IDEMPOTÊNCIA: 30 chamadas CONCORRENTES para o mesmo alerta/chave -> exatamente
  UMA mensagem (1 CRIADA + 29 JA_EXISTIA)".
- **Claim** (item 24): `comunicacao-claim-concorrencia.test.js` — "duas
  execuções concorrentes nunca reivindicam o mesmo job".
- **Crash após provider** (item 25): `comunicacao-ttl-unknown-reconciliacao.test.js`
  — "a varredura de SENDING com lease vencido move a MENSAGEM para
  DELIVERY_UNKNOWN; o alerta segue ativo".

Todos são testes de **integração** (`{skip: PULAR_INTEGRACAO}`), rodam
contra um banco de teste real — autoskip sem credencial, mesmo padrão do
resto do projeto.

## Allowlist — testes novos (item 26)

`backend/test/comunicacao-piloto.test.js` (14 testes) + 4 novos em
`comunicacao-policy.test.js`: itens A-F do checkpoint, mais retrocompatibilidade
(campo ausente não bloqueia) e precedência (um bloqueio anterior no pipeline
sempre vence a allowlist, nunca o contrário).

## Checklist visual de prontidão (itens 34-36)

`GET .../organizacoes/:id` agora devolve `checklistPiloto` — **100%
derivado** dos dados já existentes, nenhuma coluna nova de banco:
`perfilAssociado`, `telefoneValido`, `consentimento`, `telefoneVerificado`,
`timezone`, `tipoAlerta`, `allowlistPiloto` (booleano — nunca a lista crua),
`organizacaoHabilitada`, `comunicacaoGlobalAtiva`. Os dois últimos são
sempre `false` hoje (porque `habilitado`/`modo` são de fato `false`/`DISABLED`
— nunca hardcoded no código). Renderizado no drawer do Painel Administrativo
(`htmlChecklistPiloto`), com texto "(pronto)"/"(pendente)" além do
ícone/cor (acessibilidade, item 33).

## Rate-limit / cooldown / horário / jitter (itens 27-30)

Nenhum valor alterado. Confirmados como já existentes e inalterados:
rate-limit global (5/min) + por organização (3/min) + por contato/dia (3),
cooldown por severidade (atenção 8h / crítico 4h), horário comercial IANA
com DST-safe, jitter determinístico (sha256, nunca `Math.random`) — todos
em `comunicacao.config.js`/`comunicacao.horario.js`, nenhum tocado.

## Checkpoint H.4-A.1 — publicação das proteções, ainda sem envio

Publica em produção TODO o conjunto acima (allowlist, preview, checklist,
template revisado, testes) com `modo=DISABLED` e nenhuma organização
habilitada — zero mudança de comportamento visível para o piloto em si.

**Gate bloqueante para o H.4-B** (nenhum destes existe hoje; a mera
publicação do código não os satisfaz): antes de `modo=NORMAL` ou de
`habilitado=true` para qualquer organização, é obrigatório provar
simultaneamente `COMUNICACAO_PILOTO_ENABLED=true` **e** uma allowlist
válida (não ausente, não vazia, não malformada) configurada no Render —
nenhuma das duas coisas pode ficar implícita.

Auditoria read-only da organização piloto (Grupo Jailton e Vanessa,
`00000000-0000-0000-0000-000000000001`) no momento da publicação: a tabela
`comunicacao_alertas` está **vazia em toda a produção** (0 linhas, todas as
organizações) — como `detectarESincronizarAlertas` grava uma linha para
toda unidade com criticidade atenção/crítico a cada ciclo (worker já ligado
desde H.2-B), isso prova que não existe pendência real `dashboard_ifood_d1`
em nenhuma organização agora, incluindo a piloto. `preverMensagem()`
devolve `disponivel:false` para ela neste momento — resultado correto, não
uma falha.

## O que ainda falta para o primeiro envio real (H.4-B+)

1. Confirmação explícita do usuário sobre a organização piloto e o
   consentimento do número real.
2. Aplicar essa configuração em produção via o Painel Administrativo
   (endpoint já existe e já é seguro — `habilitado` continua hard-coded
   `false`).
3. Decisão explícita de ligar `COMUNICACAO_PILOTO_ENABLED=true` +
   `COMUNICACAO_PILOTO_TELEFONES_E164` em produção (Render, fora deste
   checkpoint).
4. Decisão explícita de `habilitado=true` para a organização piloto — via
   uma rota administrativa NOVA e dedicada (H.3-A/A.1/B nunca expuseram
   isso; H.4-A também não).
5. Decisão explícita de `definirModo(NORMAL)` — nenhuma rota expõe isso
   hoje.
6. Gate dedicado de shutdown/concorrência em rolling deploy real (risco já
   registrado no H.2-B/H.3-B, ainda não fechado com um teste end-to-end
   contra o Render de verdade — os testes de concorrência acima provam a
   camada de banco, não o comportamento do Render em si).
